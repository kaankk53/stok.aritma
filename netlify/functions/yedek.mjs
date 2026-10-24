import { getStore } from '@netlify/blobs';
import { createHandler } from '../../lib/handler.mjs';

// Her gün 01:00 UTC (Türkiye saatiyle 04:00) otomatik yedek alır, son 14 yedeği saklar.
export default async () => {
  const blobs = getStore({ name: 'aritma-stok', consistency: 'strong' });
  const store = {
    get: (anahtar) => blobs.get(anahtar, { type: 'json' }),
    set: (anahtar, deger) => blobs.setJSON(anahtar, deger)
  };
  const h = createHandler({ store, env: process.env });
  const sonuc = await h.yedekAl();
  console.log('Yedek alındı', JSON.stringify(sonuc));
};

export const config = { schedule: '0 1 * * *' };
