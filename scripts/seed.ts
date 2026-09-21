import { resolve } from 'node:path';
import { AppDatabase } from '../src/server/database.js';
import { seedDatabase } from '../src/server/seed.js';

const databasePath = process.env.DEEMBED_DB ?? resolve('data/deembed.sqlite');
const database = new AppDatabase(databasePath);
try {
  const result = await seedDatabase(database);
  console.log(`Seeded ${result.networks.length} networks and ${result.runs.length} runs into ${databasePath}`);
} finally {
  database.close();
}
