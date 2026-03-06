// EIP-1193 Ethereum Provider type — augments global Window
// This eliminates (window as any).ethereum throughout the codebase

interface EIP1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<any>;
  on(event: string, handler: (...args: any[]) => void): void;
  removeListener(event: string, handler: (...args: any[]) => void): void;
}

interface Window {
  ethereum?: EIP1193Provider;
}
