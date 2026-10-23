import { getStore } from '@netlify/blobs';
import { createHandler } from '../../lib/handler.mjs';

export default async (req) => {
  const blobs = getStore({ name: 'aritma-stok', consistency: 'strong' });
  const store = {
    get: (anahtar) => blobs.get(anahtar, { type: 'json' }),
    set: (anahtar, deger) => blobs.setJSON(anahtar, deger)
  };
  return createHandler({ store, env: process.env })(req);
};

export const config = { path: '/api/*' };
