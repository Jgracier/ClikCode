import { readEnv } from '../config/env.ts';

export interface PoolConfig {
  url: string;
  size: number;
}

export function poolConfig(): PoolConfig {
  const size = readEnv('DB_POOL_SIZE');
  return { url: readEnv('DB_URL', 'postgres://localhost/app'), size: size ? Number(size) : 5 };
}
