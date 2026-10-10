export interface PoolConfig {
  url: string;
  size: number;
}

export function poolConfig(): PoolConfig {
  const { DB_URL = 'postgres://localhost/app', DB_POOL_SIZE } = process.env;
  return { url: DB_URL, size: DB_POOL_SIZE ? Number(DB_POOL_SIZE) : 5 };
}
