import { resolve } from 'node:path';
import { createApp } from './app.js';

const env = process.env;
const port = Number(env.PORT ?? 3000);

const app = createApp({
  dbPath: env.DB_PATH ?? resolve('data/poker.db'),
  publicDir: env.PUBLIC_DIR ?? resolve('public'),
  registrationCode: env.REGISTRATION_CODE || undefined,
  secureCookies: env.COOKIE_SECURE === '1',
  trustProxy: env.TRUST_PROXY === '1',
});

app.server.listen(port, () => {
  console.log(`Покер-рум запущен: http://localhost:${port}`);
  if (!env.REGISTRATION_CODE) console.log('Внимание: REGISTRATION_CODE не задан — регистрироваться может любой.');
});

const stop = async () => {
  console.log('Останавливаюсь…');
  await app.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
