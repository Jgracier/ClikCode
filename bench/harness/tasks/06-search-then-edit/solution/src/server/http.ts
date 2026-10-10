import { readEnv } from '../config/env.ts';

export interface ListenOptions {
  host: string;
  port: number;
}

export function listenOptions(): ListenOptions {
  return {
    host: readEnv('HOST', '127.0.0.1'),
    port: Number(readEnv('PORT', '8080')),
  };
}
