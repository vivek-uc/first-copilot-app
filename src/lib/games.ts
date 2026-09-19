import { eq, asc, and, inArray } from 'drizzle-orm';
import type { Database } from './db';
import { games, categories, publishers } from '../../db/schema';
import type { Game } from '../types/game';

export interface GameFilters {
    categoryIds?: number[];
    publisherIds?: number[];
}

const gameSelection = {
    id: games.id,
    title: games.title,
    description: games.description,
    starRating: games.starRating,
    categoryId: categories.id,
    categoryName: categories.name,
    publisherId: publishers.id,
    publisherName: publishers.name,
};

type GameSelectionRow = {
    id: number;
    title: string;
    description: string;
    starRating: number | null;
    categoryId: number | null;
    categoryName: string | null;
    publisherId: number | null;
    publisherName: string | null;
};

function normalizeFilterIds(values?: number[]): number[] | undefined {
    if (!values || values.length === 0) {
        return undefined;
    }

    const normalized = [...new Set(values.filter((value) => Number.isInteger(value) && value > 0))];
    return normalized.length > 0 ? normalized : undefined;
}

function mapGame(row: GameSelectionRow): Game {
    return {
        id: row.id,
        title: row.title,
        description: row.description,
        starRating: row.starRating,
        category:
            row.categoryId !== null && row.categoryName !== null
                ? { id: row.categoryId, name: row.categoryName }
                : null,
        publisher:
            row.publisherId !== null && row.publisherName !== null
                ? { id: row.publisherId, name: row.publisherName }
                : null,
    };
}

function baseGamesQuery(db: Database) {
    return db
        .select(gameSelection)
        .from(games)
        .leftJoin(categories, eq(games.categoryId, categories.id))
        .leftJoin(publishers, eq(games.publisherId, publishers.id));
}

type FilterableQuery = {
    where: (condition: ReturnType<typeof and>) => unknown;
};

function applyGameFilters<T extends FilterableQuery>(query: T, filters: GameFilters = {}): T {
    const categoryIds = normalizeFilterIds(filters.categoryIds);
    const publisherIds = normalizeFilterIds(filters.publisherIds);

    const conditions: ReturnType<typeof eq>[] = [];
    if (categoryIds) {
        conditions.push(inArray(games.categoryId, categoryIds));
    }
    if (publisherIds) {
        conditions.push(inArray(games.publisherId, publisherIds));
    }

    if (conditions.length === 0) {
        return query;
    }

    return query.where(and(...conditions)) as T;
}

/** All games ordered by title, optionally filtered by category and/or publisher. */
export async function getAllGames(db: Database, filters: GameFilters = {}): Promise<Game[]> {
    const rows = await applyGameFilters(baseGamesQuery(db), filters).orderBy(asc(games.title));
    return rows.map(mapGame);
}

/** All game ids ordered by title, optionally filtered by category and/or publisher. */
export async function getAllGameIds(db: Database, filters: GameFilters = {}): Promise<number[]> {
    const rows = await applyGameFilters(
        db.select({ id: games.id }).from(games),
        filters,
    ).orderBy(asc(games.title));
    return rows.map((row) => row.id);
}

/** A single game by id, or null when it does not exist. */
export async function getGameById(db: Database, id: number): Promise<Game | null> {
    const row = await baseGamesQuery(db).where(eq(games.id, id)).get();
    return row ? mapGame(row) : null;
}
