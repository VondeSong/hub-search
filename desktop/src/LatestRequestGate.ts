export class LatestRequestGate {
  private sequence = 0;

  begin(): number {
    this.sequence += 1;
    return this.sequence;
  }

  invalidate(): void {
    this.sequence += 1;
  }

  isCurrent(request: number): boolean {
    return request === this.sequence;
  }
}
