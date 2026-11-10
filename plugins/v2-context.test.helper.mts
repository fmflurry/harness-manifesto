// The slice of the OpenCode 2 plugin context the harness plugins use, for tests. Each hook
// registration is kept by name, and `events` is the stream `ctx.event.subscribe()` yields.
type Hook = (event: Record<string, unknown>) => unknown;

export type SessionRow = {
  id: string;
  agent?: string;
  outcome?: unknown;
  time: { busy?: number; idle?: number };
};

export type FakeContextOptions = {
  events?: readonly Record<string, unknown>[];
  children?: readonly SessionRow[];
  parentID?: string;
};

export const fakeContext = (directory: string, options: FakeContextOptions = {}) => {
  const hooks = new Map<string, Hook[]>();
  const prompts: { sessionID: string; text: string }[] = [];
  const registration = { dispose: () => Promise.resolve() };
  const add = (name: string, hook: Hook) => {
    hooks.set(name, [...(hooks.get(name) ?? []), hook]);
    return Promise.resolve(registration);
  };
  const ctx = {
    location: { directory, project: { id: "p", directory, canonical: directory } },
    app: { version: "2.2.7" },
    tool: {
      hook: (name: string, hook: Hook) => add(`tool.${name}`, hook),
      transform: () => Promise.resolve(registration),
    },
    session: {
      hook: (name: string, hook: Hook) => add(`session.${name}`, hook),
      get: () => Promise.resolve({ parentID: options.parentID }),
      list: () => Promise.resolve({ data: options.children ?? [] }),
      prompt: (input: { sessionID: string; text: string }) => {
        prompts.push(input);
        return Promise.resolve({});
      },
    },
    shell: { hook: (name: string, hook: Hook) => add(`shell.${name}`, hook) },
    event: {
      subscribe: () => ({
        async *[Symbol.asyncIterator]() {
          for (const event of options.events ?? []) yield event;
        },
      }),
    },
  };
  const run = async (name: string, event: Record<string, unknown>) => {
    for (const hook of hooks.get(name) ?? []) await hook(event);
  };
  return { ctx, run, prompts };
};
