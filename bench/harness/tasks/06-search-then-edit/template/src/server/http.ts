export interface ListenOptions {
  host: string;
  port: number;
}

export function listenOptions(): ListenOptions {
  return {
    host: process.env.HOST || '127.0.0.1',
    port: Number(process.env.PORT ?? 8080),
  };
}
