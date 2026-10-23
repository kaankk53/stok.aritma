import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../lib/handler.mjs';

function yeniOrtam(ek = {}) {
  const veri = new Map();
  const store = {
    get: async (k) => (veri.has(k) ? JSON.parse(veri.get(k)) : null),
    set: async (k, v) => { veri.set(k, JSON.stringify(v)); }
  };
  const handler = createHandler({
    store,
    env: { JWT_SECRET: 'x'.repeat(32), ADMIN_PASSWORD: 'Yonetici123!', ...ek }
  });
  const istek = async (yontem, yol, govde, token) => {
    const r = await handler(new Request('http://test/api/' + yol, {
      method: yontem,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
      body: govde ? JSON.stringify(govde) : undefined
    }));
    return { status: r.status, veri: await r.json() };
  };
  return { istek, veri };
}

async function adminGiris(o) {
  const r = await o.istek('POST', 'login', { username: 'admin', password: 'Yonetici123!' });
  assert.equal(r.status, 200);
  return r.veri.token;
}

const URUNLER = [
  { barkod: '1001', ad: 'Membran 75 GPD', kategori: 'Membran', alis: 245, perakende: 450, toptan: 330, stok: 40, min: 15 },
  { barkod: '1002', ad: 'Sediment Filtre', kategori: 'Filtre', alis: 28, perakende: 65, stok: 200, min: 40 }
];

test('JWT_SECRET yoksa kurulum uyarısı verir', async () => {
  const o = yeniOrtam({ JWT_SECRET: '' });
  const r = await o.istek('GET', 'durum');
  assert.equal(r.status, 500);
});

test('ilk kurulum: yanlış şifre reddedilir, doğru şifre yönetici açar', async () => {
  const o = yeniOrtam();
  assert.equal((await o.istek('GET', 'durum')).veri.kurulumGerekli, true);
  assert.equal((await o.istek('POST', 'login', { username: 'admin', password: 'yanlis' })).status, 401);
  const t = await adminGiris(o);
  const me = await o.istek('GET', 'me', null, t);
  assert.equal(me.veri.role, 'admin');
  assert.equal((await o.istek('GET', 'durum')).veri.kurulumGerekli, false);
  assert.equal(JSON.stringify(me.veri).includes('hash'), false);
});

test('oturumsuz istek 401 döner', async () => {
  const o = yeniOrtam();
  assert.equal((await o.istek('GET', 'products')).status, 401);
});

test('personel ekleme, giriş ve maliyet gizleme', async () => {
  const o = yeniOrtam();
  const ta = await adminGiris(o);
  await o.istek('POST', 'products/import', { mod: 'ekle', toptanMarj: 12, urunler: URUNLER }, ta);

  const yeni = await o.istek('POST', 'users', { username: 'Ayse', name: 'Ayşe Yılmaz', password: 'personel123', role: 'staff' }, ta);
  assert.equal(yeni.status, 201);
  assert.equal(yeni.veri.username, 'ayse');
  assert.equal((await o.istek('POST', 'users', { username: 'ayse', name: 'X', password: 'personel123' }, ta)).status, 409);
  assert.equal((await o.istek('POST', 'users', { username: 'kisa', name: 'X', password: '123' }, ta)).status, 400);

  const tp = (await o.istek('POST', 'login', { username: 'ayse', password: 'personel123' })).veri.token;
  const urunler = await o.istek('GET', 'products', null, tp);
  assert.equal(urunler.status, 200);
  assert.equal(urunler.veri.length, 2);
  assert.equal(JSON.stringify(urunler.veri).includes('alis'), false);
  const yonetici = await o.istek('GET', 'products', null, ta);
  assert.equal(yonetici.veri[0].alis, 245);
});

test('personel yönetici işlemlerini yapamaz', async () => {
  const o = yeniOrtam();
  const ta = await adminGiris(o);
  await o.istek('POST', 'users', { username: 'ali', name: 'Ali', password: 'personel123' }, ta);
  const tp = (await o.istek('POST', 'login', { username: 'ali', password: 'personel123' })).veri.token;
  for (const [m, y, b] of [
    ['GET', 'users'], ['POST', 'users', { username: 'x1x', name: 'x', password: 'abcdefgh' }],
    ['POST', 'products/import', { urunler: URUNLER }], ['GET', 'settings'], ['PUT', 'settings', { kargo: 1 }],
    ['DELETE', 'products/1001'], ['POST', 'products', URUNLER[0]]
  ]) {
    assert.equal((await o.istek(m, y, b, tp)).status, 403, `${m} ${y}`);
  }
});

test('içe aktarma: toptan marjı, hatalı satır, stok ekleme ve değiştirme', async () => {
  const o = yeniOrtam();
  const ta = await adminGiris(o);
  let r = await o.istek('POST', 'products/import', {
    mod: 'ekle', toptanMarj: 20,
    urunler: [...URUNLER, { barkod: '', ad: 'Hatalı', alis: 1, perakende: 2 }]
  }, ta);
  assert.equal(r.veri.yeni, 2);
  assert.equal(r.veri.hataSayisi, 1);
  let l = (await o.istek('GET', 'products', null, ta)).veri;
  assert.equal(l.find((u) => u.barkod === '1002').toptan, 33.6);
  r = await o.istek('POST', 'products/import', { mod: 'ekle', urunler: [{ ...URUNLER[0], stok: 10 }] }, ta);
  assert.equal(r.veri.guncel, 1);
  l = (await o.istek('GET', 'products', null, ta)).veri;
  assert.equal(l.find((u) => u.barkod === '1001').stok, 50);
  await o.istek('POST', 'products/import', { mod: 'yaz', urunler: [{ ...URUNLER[0], stok: 7 }] }, ta);
  l = (await o.istek('GET', 'products', null, ta)).veri;
  assert.equal(l.find((u) => u.barkod === '1001').stok, 7);
});

test('ürün ekle, düzenle, sil', async () => {
  const o = yeniOrtam();
  const ta = await adminGiris(o);
  assert.equal((await o.istek('POST', 'products', { barkod: '9', ad: 'Pompa', alis: 500, perakende: 890 }, ta)).status, 201);
  assert.equal((await o.istek('POST', 'products', { barkod: '9', ad: 'Pompa', alis: 500, perakende: 890 }, ta)).status, 409);
  const g = await o.istek('PUT', 'products/9', { perakende: 950, stok: 12, toptan: null }, ta);
  assert.equal(g.veri.perakende, 950);
  assert.equal(g.veri.stok, 12);
  assert.equal(g.veri.alis, 500);
  assert.equal((await o.istek('DELETE', 'products/9', null, ta)).status, 200);
  assert.equal((await o.istek('DELETE', 'products/9', null, ta)).status, 404);
});

test('satış: stok düşer, personel maliyeti görmez, yönetici görür', async () => {
  const o = yeniOrtam();
  const ta = await adminGiris(o);
  await o.istek('POST', 'products/import', { urunler: URUNLER }, ta);
  await o.istek('POST', 'users', { username: 'ayse', name: 'Ayşe', password: 'personel123' }, ta);
  const tp = (await o.istek('POST', 'login', { username: 'ayse', password: 'personel123' })).veri.token;

  const s = await o.istek('POST', 'sales', { mod: 'toptan', satirlar: [{ barkod: '1001', adet: 3 }, { barkod: '1001', adet: 2 }] }, tp);
  assert.equal(s.status, 201);
  assert.equal(s.veri.satis.ciro, 330 * 5);
  assert.equal(JSON.stringify(s.veri).includes('alis'), false);
  assert.equal(JSON.stringify(s.veri).includes('maliyet'), false);

  const l = (await o.istek('GET', 'products', null, ta)).veri;
  assert.equal(l.find((u) => u.barkod === '1001').stok, 35);

  const yo = await o.istek('GET', 'sales', null, ta);
  assert.equal(yo.veri.length, 1);
  assert.equal(yo.veri[0].maliyet, 245 * 5);
  assert.equal(yo.veri[0].user.name, 'Ayşe');

  const pe = await o.istek('GET', 'sales', null, tp);
  assert.equal(pe.veri.length, 1);
  assert.equal(JSON.stringify(pe.veri).includes('maliyet'), false);

  // yönetici kendi satışı yapar, personel yalnızca kendi satışlarını görür
  await o.istek('POST', 'sales', { mod: 'perakende', satirlar: [{ barkod: '1002', adet: 1 }] }, ta);
  assert.equal((await o.istek('GET', 'sales', null, ta)).veri.length, 2);
  assert.equal((await o.istek('GET', 'sales', null, tp)).veri.length, 1);
});

test('satış doğrulamaları', async () => {
  const o = yeniOrtam();
  const ta = await adminGiris(o);
  await o.istek('POST', 'products/import', { urunler: URUNLER }, ta);
  assert.equal((await o.istek('POST', 'sales', { satirlar: [] }, ta)).status, 400);
  assert.equal((await o.istek('POST', 'sales', { satirlar: [{ barkod: 'yok', adet: 1 }] }, ta)).status, 404);
  assert.equal((await o.istek('POST', 'sales', { satirlar: [{ barkod: '1001', adet: 999 }] }, ta)).status, 409);
  assert.equal((await o.istek('POST', 'sales', { satirlar: [{ barkod: '1001', adet: 0 }] }, ta)).status, 400);
  const l = (await o.istek('GET', 'products', null, ta)).veri;
  assert.equal(l.find((u) => u.barkod === '1001').stok, 40);
});

test('satış raporu tarih aralığına göre süzülür', async () => {
  const o = yeniOrtam();
  const ta = await adminGiris(o);
  await o.istek('POST', 'products/import', { urunler: URUNLER }, ta);
  await o.istek('POST', 'sales', { satirlar: [{ barkod: '1002', adet: 2 }] }, ta);
  const gecmis = await o.istek('GET', 'sales?from=2020-01-01&to=2020-02-01', null, ta);
  assert.equal(gecmis.veri.length, 0);
  const bugun = new Date().toISOString().slice(0, 10);
  const yarin = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
  assert.equal((await o.istek('GET', `sales?from=${bugun}&to=${yarin}`, null, ta)).veri.length, 1);
  assert.equal((await o.istek('GET', 'sales?from=bozuk', null, ta)).status, 400);
});

test('son yönetici korunur, kendi hesabı silinemez', async () => {
  const o = yeniOrtam();
  const ta = await adminGiris(o);
  const me = (await o.istek('GET', 'me', null, ta)).veri;
  assert.equal((await o.istek('PATCH', 'users/' + me.id, { active: false }, ta)).status, 409);
  assert.equal((await o.istek('PATCH', 'users/' + me.id, { role: 'staff' }, ta)).status, 409);
  assert.equal((await o.istek('DELETE', 'users/' + me.id, null, ta)).status, 409);
});

test('pasifleştirilen kullanıcının oturumu hemen geçersiz olur', async () => {
  const o = yeniOrtam();
  const ta = await adminGiris(o);
  const k = (await o.istek('POST', 'users', { username: 'veli', name: 'Veli', password: 'personel123' }, ta)).veri;
  const tp = (await o.istek('POST', 'login', { username: 'veli', password: 'personel123' })).veri.token;
  assert.equal((await o.istek('GET', 'products', null, tp)).status, 200);
  await o.istek('PATCH', 'users/' + k.id, { active: false }, ta);
  assert.equal((await o.istek('GET', 'products', null, tp)).status, 401);
  assert.equal((await o.istek('POST', 'login', { username: 'veli', password: 'personel123' })).status, 401);
  await o.istek('PATCH', 'users/' + k.id, { active: true, password: 'yenisifre99' }, ta);
  assert.equal((await o.istek('POST', 'login', { username: 'veli', password: 'yenisifre99' })).status, 200);
  assert.equal((await o.istek('DELETE', 'users/' + k.id, null, ta)).status, 200);
});

test('kullanıcı kendi şifresini değiştirir', async () => {
  const o = yeniOrtam();
  const ta = await adminGiris(o);
  assert.equal((await o.istek('POST', 'me/password', { eski: 'yanlis', yeni: 'yeniSifre123' }, ta)).status, 400);
  assert.equal((await o.istek('POST', 'me/password', { eski: 'Yonetici123!', yeni: 'kisa' }, ta)).status, 400);
  assert.equal((await o.istek('POST', 'me/password', { eski: 'Yonetici123!', yeni: 'yeniSifre123' }, ta)).status, 200);
  assert.equal((await o.istek('POST', 'login', { username: 'admin', password: 'yeniSifre123' })).status, 200);
});

test('ayarlar kaydedilir ve doğrulanır', async () => {
  const o = yeniOrtam();
  const ta = await adminGiris(o);
  const r = await o.istek('PUT', 'settings', { kargo: 75, kdvAcik: true, kom: { trendyol: 18 }, bag: { n11: { durum: 'taslak', stok: false } } }, ta);
  assert.equal(r.status, 200);
  assert.equal(r.veri.kargo, 75);
  assert.equal(r.veri.kom.trendyol, 18);
  assert.equal(r.veri.kom.n11, 12);
  assert.equal(r.veri.bag.n11.stok, false);
  assert.equal((await o.istek('PUT', 'settings', { kargo: 'abc' }, ta)).status, 400);
  assert.equal((await o.istek('GET', 'settings', null, ta)).veri.kargo, 75);
});

test('bozuk token reddedilir', async () => {
  const o = yeniOrtam();
  assert.equal((await o.istek('GET', 'me', null, 'abc.def')).status, 401);
  assert.equal((await o.istek('GET', 'me', null, 'x')).status, 401);
});
