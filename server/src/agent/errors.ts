export class AgentError extends Error {
  constructor(
    message: string,
    public code = "error",
  ) {
    super(message);
  }
}