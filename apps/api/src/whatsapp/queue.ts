export class SendQueue {
  private readonly tails = new Map<string, Promise<void>>();

  enqueue<T>(key: string, job: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const run = previous.then(job, job);
    this.tails.set(key, run.then(() => undefined, () => undefined));
    return run;
  }
}
