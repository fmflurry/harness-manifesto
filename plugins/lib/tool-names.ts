// OpenCode 1 named the shell tool `bash`; OpenCode 2 names it `shell`.
export const isShellTool = (tool: string | undefined): boolean => {
  const name = tool?.toLowerCase();
  return name === "shell" || name === "bash";
};
