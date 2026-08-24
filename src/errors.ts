export class RRuleTZError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RRuleTZError';
  }
}
