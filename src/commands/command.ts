export type Command = {
  readonly summary: string;
  readonly run: (argv: readonly string[]) => Promise<number>;
};
