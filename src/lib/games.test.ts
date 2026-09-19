import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDatabase } from '../../db/test-helpers';
import { categories, publishers, games } from '../../db/schema';
import type { Database } from './db';
import {
    getAllGames,
    getAllGameIds,
    getGameById,
} from './games';

async function seedGames(db: Database, count: number): Promise<void> {
    const [category] = await db
        .insert(categories)
        .values({ name: 'Strategy', description: 'cat' })
        .returning({ id: categories.id });
    const [publisher] = await db
        .insert(publishers)
        .values({ name: 'Pub One', description: 'pub' })
        .returning({ id: publishers.id });

    // Insert titles in reverse-alphabetical order to prove ordering is applied.
    for (let i = count; i >= 1; i--) {
        await db.insert(games).values({
            title: `Game ${String(i).padStart(2, '0')}`,
            description: `Description ${i}`,
            starRating: 4.2,
            categoryId: category.id,
            publisherId: publisher.id,
        });
    }
}

async function seedFilteredGames(db: Database): Promise<{
    strategyId: number;
    racingId: number;
    pubOneId: number;
    pubTwoId: number;
    alphaId: number;
    betaId: number;
    gammaId: number;
}> {
    const [strategy] = await db
        .insert(categories)
        .values({ name: 'Strategy', description: 'cat' })
        .returning({ id: categories.id });
    const [racing] = await db
        .insert(categories)
        .values({ name: 'Racing', description: 'cat' })
        .returning({ id: categories.id });
    const [pubOne] = await db
        .insert(publishers)
        .values({ name: 'Pub One', description: 'pub' })
        .returning({ id: publishers.id });
    const [pubTwo] = await db
        .insert(publishers)
        .values({ name: 'Pub Two', description: 'pub' })
        .returning({ id: publishers.id });

    const alpha = await db.insert(games).values({
        title: 'Alpha Adventure',
        description: 'Strategy under Pub One',
        starRating: 4.7,
        categoryId: strategy.id,
        publisherId: pubOne.id,
    }).returning({ id: games.id });
    const beta = await db.insert(games).values({
        title: 'Beta Dash',
        description: 'Racing under Pub One',
        starRating: 4.3,
        categoryId: racing.id,
        publisherId: pubOne.id,
    }).returning({ id: games.id });
    const gamma = await db.insert(games).values({
        title: 'Gamma Quest',
        description: 'Strategy under Pub Two',
        starRating: 4.1,
        categoryId: strategy.id,
        publisherId: pubTwo.id,
    }).returning({ id: games.id });

    return {
        strategyId: strategy.id,
        racingId: racing.id,
        pubOneId: pubOne.id,
        pubTwoId: pubTwo.id,
        alphaId: alpha[0].id,
        betaId: beta[0].id,
        gammaId: gamma[0].id,
    };
}

describe('games data-access helpers', () => {
    let db: Database;

    beforeEach(async () => {
        db = await createTestDatabase();
    });

    it('returns all games ordered by title', async () => {
        await seedGames(db, 3);
        const all = await getAllGames(db);
        expect(all.map((g) => g.title)).toEqual(['Game 01', 'Game 02', 'Game 03']);
        expect(all[0].category).toEqual({ id: expect.any(Number), name: 'Strategy' });
        expect(all[0].publisher).toEqual({ id: expect.any(Number), name: 'Pub One' });
    });

    it('returns all game ids ordered by title', async () => {
        await seedGames(db, 3);
        const ids = await getAllGameIds(db);
        const all = await getAllGames(db);
        expect(ids).toEqual(all.map((g) => g.id));
    });

    it('filters games by category and publisher together', async () => {
        const { strategyId, pubOneId, alphaId } = await seedFilteredGames(db);

        const filteredGames = await getAllGames(db, {
            categoryIds: [strategyId],
            publisherIds: [pubOneId],
        });

        expect(filteredGames.map((game) => game.title)).toEqual(['Alpha Adventure']);
        expect(await getAllGameIds(db, {
            categoryIds: [strategyId],
            publisherIds: [pubOneId],
        })).toEqual([alphaId]);
    });

    it('supports selecting multiple categories with OR logic', async () => {
        const { strategyId, racingId, alphaId, betaId, gammaId } = await seedFilteredGames(db);

        const filteredGames = await getAllGames(db, {
            categoryIds: [strategyId, racingId],
        });

        expect(filteredGames.map((game) => game.id)).toEqual([alphaId, betaId, gammaId]);
    });

    it('fetches a single game by id', async () => {
        await seedGames(db, 2);
        const ids = await getAllGameIds(db);
        const game = await getGameById(db, ids[0]);
        expect(game?.title).toBe('Game 01');
    });

    it('returns null for a non-existent game', async () => {
        await seedGames(db, 2);
        expect(await getGameById(db, 99999)).toBeNull();
    });
});
