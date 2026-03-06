// EIP-6963: Multi Injected Provider Discovery
// Detects all installed EVM wallets in the browser

export interface EIP6963ProviderInfo {
  uuid: string;
  name: string;
  icon: string; // data URI
  rdns: string; // reverse DNS identifier
}

export interface EIP6963ProviderDetail {
  info: EIP6963ProviderInfo;
  provider: EIP1193Provider;
}

interface EIP6963AnnounceEvent extends Event {
  detail: EIP6963ProviderDetail;
}

/** Discover all installed EVM wallets via EIP-6963.
 *  Returns a promise that resolves after a short collection window. */
export function discoverWallets(): Promise<EIP6963ProviderDetail[]> {
  if (typeof window === "undefined") return Promise.resolve([]);

  const wallets: EIP6963ProviderDetail[] = [];
  const seen = new Set<string>();

  return new Promise((resolve) => {
    function handleAnnounce(event: Event) {
      const e = event as EIP6963AnnounceEvent;
      if (!e.detail?.info?.uuid || seen.has(e.detail.info.uuid)) return;
      seen.add(e.detail.info.uuid);
      wallets.push(e.detail);
    }

    window.addEventListener("eip6963:announceProvider", handleAnnounce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));

    // Give wallets 200ms to announce themselves
    setTimeout(() => {
      window.removeEventListener("eip6963:announceProvider", handleAnnounce);
      resolve(wallets);
    }, 200);
  });
}
