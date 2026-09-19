import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { CanvasError, createCanvas, joinSession } from "@github/copilot-sdk/extension";

const execFileAsync = promisify(execFile);
const servers = new Map();
const issueFields = "number,title,body,url,labels,updatedAt,createdAt,assignees,comments,state";

function repositoryFromRemote(remote) {
    const match = remote.trim().match(/github\.com[/:]([^/]+\/[^/.]+)(?:\.git)?$/);
    if (!match) {
        throw new Error("The current repository is not a GitHub repository.");
    }
    return match[1];
}

async function currentRepository() {
    const { stdout } = await execFileAsync("git", ["config", "--get", "remote.origin.url"]);
    return repositoryFromRemote(stdout);
}

function labelNames(issue) {
    return issue.labels.map((label) => typeof label === "string" ? label : label.name).filter(Boolean);
}

function urgencyFor(issue) {
    const labels = labelNames(issue).map((label) => label.toLowerCase());
    const commentCount = Array.isArray(issue.comments) ? issue.comments.length : Number(issue.comments) || 0;
    const reasons = [];
    let score = 0;

    if (labels.some((label) => /(blocker|critical|urgent|priority: ?high|p0|p1)/.test(label))) {
        score += 8;
        reasons.push("high-priority labeling");
    } else if (labels.some((label) => /(bug|security|regression|incident)/.test(label))) {
        score += 5;
        reasons.push("risk-oriented labeling");
    }
    if (issue.assignees.length === 0) {
        score += 3;
        reasons.push("no assignee");
    }
    if (commentCount > 0) {
        score += Math.min(commentCount, 3);
        reasons.push(`${commentCount} comment${commentCount === 1 ? "" : "s"} to review`);
    }
    const ageInDays = Math.max(0, (Date.now() - Date.parse(issue.updatedAt)) / 86_400_000);
    if (ageInDays < 7) {
        score += 2;
        reasons.push("recent activity");
    } else if (ageInDays > 30) {
        score += 1;
        reasons.push("stale and may need a decision");
    }

    if (reasons.length === 0) reasons.push("no special urgency signal; included for visibility");
    return { score, justification: reasons.join(", ") };
}

async function listIssues(repository) {
    const targetRepository = repository ?? await currentRepository();
    const { stdout } = await execFileAsync("gh", [
        "issue", "list", "--repo", targetRepository, "--state", "open",
        "--limit", "100", "--json", issueFields,
    ]);
    const issues = JSON.parse(stdout);
    return issues
        .map((issue) => ({ ...issue, ...urgencyFor(issue), repository: targetRepository }))
        .sort((left, right) => right.score - left.score || Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
}

function readRequestBody(request) {
    return new Promise((resolve, reject) => {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk) => {
            body += chunk;
            if (body.length > 20_000) {
                request.destroy();
                reject(new Error("Request body is too large."));
            }
        });
        request.on("end", () => resolve(body));
        request.on("error", reject);
    });
}

function jsonResponse(response, status, value) {
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(value));
}

function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[character]);
}

function renderIssueCard(issue, topIssue) {
    const description = issue.body?.trim() || "No issue description was provided.";
    return `<article class="card ${topIssue ? "priority-card" : ""}" data-testid="issue-card-${issue.number}">
      <div class="card-heading"><span class="issue-number">#${issue.number}</span><span class="score">Urgency ${issue.score}</span></div>
      <h3><a href="${escapeHtml(issue.url)}" target="_blank" rel="noreferrer">${escapeHtml(issue.title)}</a></h3>
      <p class="description">${escapeHtml(description)}</p>
      ${topIssue ? `<p class="why"><strong>Why it is here:</strong> ${escapeHtml(issue.justification)}.</p>` : ""}
      <div class="card-footer"><span class="meta">${issue.assignees.length ? `Assigned to ${escapeHtml(issue.assignees.map((assignee) => assignee.login).join(", "))}` : "Unassigned"}</span><button type="button" data-issue="${issue.number}" data-testid="add-issue-${issue.number}">Add to context</button></div>
    </article>`;
}

function renderHtml(instanceId) {
    return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Issue triage board</title>
    <style>
      :root { color-scheme: light dark; --surface: color-mix(in srgb, var(--background-color-default, #fff) 94%, var(--text-color-default, #1f2328) 6%); --surface-strong: color-mix(in srgb, var(--background-color-default, #fff) 88%, var(--text-color-default, #1f2328) 12%); }
      * { box-sizing: border-box; } body { margin: 0; background: var(--background-color-default, #fff); color: var(--text-color-default, #1f2328); font: var(--text-body-medium, 14px)/var(--leading-body-medium, 20px) var(--font-sans, system-ui, sans-serif); }
      main { max-width: 1080px; margin: auto; padding: 28px; } header { border-bottom: 1px solid var(--border-color-default, #d0d7de); margin-bottom: 22px; padding-bottom: 18px; } h1 { margin: 0; font-size: 30px; line-height: 1.15; } h2 { font-size: 17px; margin: 28px 0 12px; } h3 { font-size: 16px; line-height: 1.35; margin: 8px 0; } p { margin: 8px 0; } .lede, .meta { color: var(--text-color-muted, #59636e); } .board { display: grid; gap: 12px; } .card { background: var(--surface); border: 1px solid var(--border-color-default, #d0d7de); border-radius: 10px; padding: 16px; } .priority-card { border-left: 4px solid var(--true-color-orange, #bc4c00); } .card-heading, .card-footer { align-items: center; display: flex; gap: 12px; justify-content: space-between; } .issue-number { color: var(--true-color-blue, #0969da); font-family: var(--font-mono, monospace); font-weight: 600; } .score { background: var(--surface-strong); border-radius: 999px; color: var(--text-color-muted, #59636e); font-size: 12px; padding: 2px 8px; } a { color: var(--true-color-blue, #0969da); } .description { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 4; overflow: hidden; white-space: pre-line; } .why { background: color-mix(in srgb, var(--true-color-orange-muted, #fff1e5) 60%, transparent); border-radius: 6px; padding: 8px 10px; } button { background: var(--true-color-blue, #0969da); border: 1px solid var(--true-color-blue, #0969da); border-radius: 7px; color: var(--color-white, #fff); cursor: pointer; font: inherit; font-weight: 600; min-height: 34px; padding: 6px 11px; } button:disabled { cursor: wait; opacity: .65; } button:focus-visible, a:focus-visible { outline: 2px solid var(--color-focus-outline, #0969da); outline-offset: 2px; } .empty, .error { border: 1px dashed var(--border-color-default, #d0d7de); border-radius: 8px; color: var(--text-color-muted, #59636e); padding: 16px; } .error { color: var(--true-color-red, #cf222e); } #status { min-height: 20px; color: var(--text-color-muted, #59636e); } @media (max-width: 640px) { main { padding: 18px; } .card-footer { align-items: flex-start; flex-direction: column; } }
    </style>
  </head>
  <body><main><header><h1>Issue triage board</h1><p class="lede">The three issues most likely to need attention are first. Each card explains the signal behind its position.</p><p id="status" role="status" aria-live="polite"></p></header><section><h2>Needs attention now</h2><div id="top" class="board"></div></section><section><h2>Remaining open issues</h2><div id="remaining" class="board"></div></section></main>
    <script>
      const topSection = document.querySelector("#top"), remaining = document.querySelector("#remaining"), status = document.querySelector("#status");
      const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
      const request = async (path, options = {}) => { const response = await fetch(path, options); const data = await response.json(); if (!response.ok) throw new Error(data.error || "Request failed."); return data; };
      const render = (data) => { topSection.innerHTML = data.top.length ? data.top.map((issue) => issue.html).join("") : '<div class="empty">No open issues need attention.</div>'; remaining.innerHTML = data.remaining.length ? data.remaining.map((issue) => issue.html).join("") : '<div class="empty">There are no remaining open issues.</div>'; };
      document.addEventListener("click", async (event) => { const button = event.target.closest("button[data-issue]"); if (!button) return; button.disabled = true; status.textContent = "Adding issue to the current context..."; try { const data = await request("/api/add-to-context", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ number: Number(button.dataset.issue) }) }); status.textContent = data.message; button.textContent = "Added to context"; } catch (error) { status.textContent = error.message; button.disabled = false; } });
      (async () => { status.textContent = "Loading open issues..."; try { render(await request("/api/issues")); status.textContent = ""; } catch (error) { topSection.innerHTML = '<div class="error">' + escapeHtml(error.message) + '</div>'; remaining.innerHTML = ""; status.textContent = ""; } })();
    </script>
  </body>
</html>`;
}

async function startServer() {
    const server = createServer(async (request, response) => {
        try {
            if (request.url === "/api/issues" && request.method === "GET") {
                const issues = await listIssues();
                const withHtml = issues.map((issue) => ({ ...issue, html: renderIssueCard(issue, issues.indexOf(issue) < 3) }));
                jsonResponse(response, 200, { top: withHtml.slice(0, 3), remaining: withHtml.slice(3) });
                return;
            }
            if (request.url === "/api/add-to-context" && request.method === "POST") {
                const input = JSON.parse(await readRequestBody(request));
                const issue = (await listIssues()).find((candidate) => candidate.number === Number(input.number));
                if (!issue) throw new Error("That open issue could not be found.");
                await session.send({ prompt: `Please triage and work on GitHub issue #${issue.number}: ${issue.title}\n${issue.url}\n\nIssue description:\n${issue.body?.trim() || "No description provided."}` });
                jsonResponse(response, 200, { message: `Issue #${issue.number} added to the current context.` });
                return;
            }
            response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            response.end(renderHtml(request.headers["x-canvas-instance"] || "board"));
        } catch (error) {
            jsonResponse(response, 400, { error: error instanceof Error ? error.message : "The request failed." });
        }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return { server, url: `http://127.0.0.1:${port}/` };
}

const session = await joinSession({
    canvases: [createCanvas({
        id: "issue-triage-board",
        displayName: "Issue triage board",
        description: "Kanban board that ranks open GitHub issues and adds a selected issue to the current session context.",
        actions: [
            { name: "list_issues", description: "List and rank the current repository's open GitHub issues.", handler: async () => listIssues() },
            {
                name: "add_issue_to_context",
                description: "Add an open GitHub issue to the current session context.",
                inputSchema: { type: "object", properties: { number: { type: "integer", minimum: 1 } }, required: ["number"], additionalProperties: false },
                handler: async (ctx) => {
                    const issue = (await listIssues()).find((candidate) => candidate.number === Number(ctx.input?.number));
                    if (!issue) throw new CanvasError("issue_not_found", "That open issue could not be found.");
                    await session.send({ prompt: `Please triage and work on GitHub issue #${issue.number}: ${issue.title}\n${issue.url}\n\nIssue description:\n${issue.body?.trim() || "No description provided."}` });
                    return { added: true, number: issue.number, title: issue.title };
                },
            },
        ],
        open: async (ctx) => {
            let entry = servers.get(ctx.instanceId);
            if (!entry) {
                entry = await startServer();
                servers.set(ctx.instanceId, entry);
            }
            return { title: "Issue triage board", url: entry.url };
        },
        onClose: async (ctx) => {
            const entry = servers.get(ctx.instanceId);
            if (entry) {
                servers.delete(ctx.instanceId);
                await new Promise((resolve) => entry.server.close(resolve));
            }
        },
    })],
});
