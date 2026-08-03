export class NestedSvc {
  run(): number {
    const ask = 1;
    const localHelper = () => ask;
    return localHelper();
  }

  login(): string {
    return 'ok';
  }
}

export const topLevelFlag = true;
