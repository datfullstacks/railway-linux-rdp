export class AgentError extends Error {
  constructor(code, message, { status = 500, retryable = false, expose = true } = {}) {
    super(message);
    this.name = 'AgentError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.expose = expose;
  }
}

export function publicError(error) {
  const exposed = error instanceof AgentError && error.expose;
  return {
    code: exposed ? error.code : 'JOB_FAILED',
    message: exposed ? error.message : 'The Multilogin job failed',
    retryable: exposed ? Boolean(error.retryable) : false
  };
}
