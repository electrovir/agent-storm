import {defineConfig} from 'prisma/config';

export default defineConfig({
    schema: '../prisma/schema.prisma',
    migrations: {
        path: '../prisma/migrations',
    },
    datasource: {
        /** Only the Prisma CLI reads this, to write migrations during development. */
        url: process.env.DATABASE_URL || 'file:./.not-committed/dev.db',
    },
});
