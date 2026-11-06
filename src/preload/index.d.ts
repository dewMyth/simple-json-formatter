import type { JsonLensApi } from '../shared/types';

declare global {
  interface Window {
    api: JsonLensApi;
  }
}

export {};
