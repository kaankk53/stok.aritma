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
    if (yol === 'login' && govde && govde.panel === undefined) {
      govde = { ...govde, panel: govde.username === 'admin' ? 'admin' : 'staff' };
    }
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

/* ---------- ayrı paneller, işler, stok sayımı ---------- */
async function personelHazirla(o, ta, kadi = 'ayse', ad = 'Ayşe Yılmaz') {
  const k = (await o.istek('POST', 'users', { username: kadi, name: ad, password: 'personel123' }, ta)).veri;
  const t = (await o.istek('POST', 'login', { username: kadi, password: 'personel123' })).veri.token;
  return { id: k.id, token: t };
}

test('paneller ayrı: personel yönetici girişinden, yönetici personel girişinden giremez', async () => {
  const o = yeniOrtam();
  const ta = await adminGiris(o);
  await personelHazirla(o, ta);
  let r = await o.istek('POST', 'login', { username: 'ayse', password: 'personel123', panel: 'admin' });
  assert.equal(r.status, 403);
  assert.equal(r.veri.token, undefined);
  r = await o.istek('POST', 'login', { username: 'admin', password: 'Yonetici123!', panel: 'staff' });
  assert.equal(r.status, 403);
  assert.equal(r.veri.token, undefined);
  r = await o.istek('POST', 'login', { username: 'ayse', password: 'yanlis', panel: 'admin' });
  assert.equal(r.status, 401);
  assert.equal((await o.istek('POST', 'login', { username: 'ayse', password: 'personel123', panel: 'x' })).status, 400);
});

test('iş oluşturma, atama ve yetki sınırları', async () => {
  const o = yeniOrtam();
  const ta = await adminGiris(o);
  const ayse = await personelHazirla(o, ta, 'ayse', 'Ayşe');
  const veli = await personelHazirla(o, ta, 'veli', 'Veli');

  assert.equal((await o.istek('POST', 'jobs', { baslik: 'x' }, ayse.token)).status, 403);
  assert.equal((await o.istek('POST', 'jobs', { baslik: '' }, ta)).status, 400);
  assert.equal((await o.istek('POST', 'jobs', { baslik: 'Filtre değişimi', atanan: 'yok' }, ta)).status, 400);

  const j1 = (await o.istek('POST', 'jobs', { baslik: 'Filtre değişimi', tur: 'filtre', musteri: 'Kaya Ltd.', termin: '2026-11-01', ucret: 900, atanan: ayse.id, oncelik: 'acil' }, ta)).veri;
  const j2 = (await o.istek('POST', 'jobs', { baslik: 'Kurulum', tur: 'kurulum', atanan: veli.id }, ta)).veri;
  assert.equal(j1.no, 1);
  assert.equal(j2.no, 2);
  assert.equal(j1.atananAd, 'Ayşe');
  assert.equal(j1.durum, 'bekliyor');

  const aysenin = (await o.istek('GET', 'jobs', null, ayse.token)).veri;
  assert.equal(aysenin.length, 1);
  assert.equal(aysenin[0].baslik, 'Filtre değişimi');
  assert.equal((await o.istek('GET', 'jobs', null, ta)).veri.length, 2);
  assert.equal((await o.istek('GET', 'jobs?atanan=' + veli.id, null, ta)).veri.length, 1);

  // başkasının işine dokunamaz
  assert.equal((await o.istek('GET', 'jobs/' + j2.id, null, ayse.token)).status, 404);
  assert.equal((await o.istek('POST', `jobs/${j2.id}/durum`, { durum: 'devam' }, ayse.token)).status, 404);
  assert.equal((await o.istek('PUT', 'jobs/' + j1.id, { baslik: 'Hack' }, ayse.token)).status, 403);
  assert.equal((await o.istek('DELETE', 'jobs/' + j1.id, null, ayse.token)).status, 403);

  // yönetici yeniden atar
  const g = await o.istek('PUT', 'jobs/' + j1.id, { atanan: veli.id, ucret: 950 }, ta);
  assert.equal(g.veri.atananAd, 'Veli');
  assert.equal(g.veri.ucret, 950);
  assert.equal((await o.istek('GET', 'jobs', null, ayse.token)).veri.length, 0);
  assert.equal((await o.istek('DELETE', 'jobs/' + j2.id, null, ta)).status, 200);
});

test('iş akışı: başla, parça kullan (stok düşer), masraf, tamamla; personel maliyeti görmez', async () => {
  const o = yeniOrtam();
  const ta = await adminGiris(o);
  await o.istek('POST', 'products/import', { urunler: URUNLER }, ta);
  const ayse = await personelHazirla(o, ta, 'ayse', 'Ayşe');
  const j = (await o.istek('POST', 'jobs', { baslik: 'Membran değişimi', ucret: 1000, atanan: ayse.id }, ta)).veri;
  const yol = (s) => `jobs/${j.id}/${s}`;

  // personel yalnızca devam/tamam yapabilir
  assert.equal((await o.istek('POST', yol('durum'), { durum: 'iptal' }, ayse.token)).status, 403);
  assert.equal((await o.istek('POST', yol('durum'), { durum: 'bekliyor' }, ayse.token)).status, 403);
  const basla = await o.istek('POST', yol('durum'), { durum: 'devam' }, ayse.token);
  assert.equal(basla.veri.durum, 'devam');
  assert.ok(basla.veri.baslama);

  // parça: stok düşer, personel alış fiyatını görmez
  let p = await o.istek('POST', yol('parts'), { barkod: '1001', adet: 2 }, ayse.token);
  assert.equal(p.status, 201);
  assert.equal(JSON.stringify(p.veri).includes('"alis"'), false);
  assert.equal(JSON.stringify(p.veri).includes('ozet'), false);
  assert.equal((await o.istek('POST', yol('parts'), { barkod: '1001', adet: 999 }, ayse.token)).status, 409);
  assert.equal((await o.istek('POST', yol('parts'), { barkod: 'yok', adet: 1 }, ayse.token)).status, 404);
  let stok = (await o.istek('GET', 'products', null, ta)).veri.find((u) => u.barkod === '1001').stok;
  assert.equal(stok, 38);

  // masraf
  assert.equal((await o.istek('POST', yol('costs'), { aciklama: 'Yol', tutar: 0 }, ayse.token)).status, 400);
  const m = await o.istek('POST', yol('costs'), { aciklama: 'Yol ve yakıt', tutar: 120, tur: 'yol' }, ayse.token);
  assert.equal(m.status, 201);
  assert.equal(m.veri.masraflar[0].tutar, 120);

  // not
  assert.equal((await o.istek('POST', yol('notes'), { metin: 'Müşteri evde değildi' }, ayse.token)).status, 201);
  assert.equal((await o.istek('POST', yol('notes'), { metin: ' ' }, ayse.token)).status, 400);

  // yönetici maliyet ve kârı görür: 2 x 245 + 120 = 610, kâr 390
  const yon = (await o.istek('GET', 'jobs/' + j.id, null, ta)).veri;
  assert.deepEqual(yon.ozet, { parca: 490, masraf: 120, maliyet: 610, kar: 390 });
  assert.equal(yon.parcalar[0].alis, 245);

  // tamamla; sonra personel değişiklik yapamaz
  const tamam = await o.istek('POST', yol('durum'), { durum: 'tamam' }, ayse.token);
  assert.equal(tamam.veri.durum, 'tamam');
  assert.ok(tamam.veri.bitis);
  assert.equal((await o.istek('POST', yol('parts'), { barkod: '1002', adet: 1 }, ayse.token)).status, 403);
  assert.equal((await o.istek('POST', yol('costs'), { aciklama: 'Ek', tutar: 5 }, ayse.token)).status, 403);
  // yeniden açar
  assert.equal((await o.istek('POST', yol('durum'), { durum: 'devam' }, ayse.token)).veri.durum, 'devam');

  // parçayı kaldırınca stok geri gelir
  const parcaId = yon.parcalar[0].id;
  const sil = await o.istek('DELETE', yol('parts/' + parcaId), null, ayse.token);
  assert.equal(sil.status, 200);
  stok = (await o.istek('GET', 'products', null, ta)).veri.find((u) => u.barkod === '1001').stok;
  assert.equal(stok, 40);
  // masraf silme: yalnızca kendi kaydı
  const masrafId = (await o.istek('GET', 'jobs/' + j.id, null, ta)).veri.masraflar[0].id;
  assert.equal((await o.istek('DELETE', yol('costs/' + masrafId), null, ayse.token)).status, 200);
});

test('personel başkasının eklediği parça/masrafı silemez', async () => {
  const o = yeniOrtam();
  const ta = await adminGiris(o);
  await o.istek('POST', 'products/import', { urunler: URUNLER }, ta);
  const ayse = await personelHazirla(o, ta, 'ayse', 'Ayşe');
  const j = (await o.istek('POST', 'jobs', { baslik: 'İş', atanan: ayse.id }, ta)).veri;
  const yonParca = (await o.istek('POST', `jobs/${j.id}/parts`, { barkod: '1002', adet: 1 }, ta)).veri.parcalar[0];
  const yonMasraf = (await o.istek('POST', `jobs/${j.id}/costs`, { aciklama: 'Yönetici masrafı', tutar: 10 }, ta)).veri.masraflar[0];
  assert.equal((await o.istek('DELETE', `jobs/${j.id}/parts/${yonParca.id}`, null, ayse.token)).status, 403);
  assert.equal((await o.istek('DELETE', `jobs/${j.id}/costs/${yonMasraf.id}`, null, ayse.token)).status, 403);
});

test('stok sayımı: personel düzeltir, neden zorunlu, hareket kaydı tutulur', async () => {
  const o = yeniOrtam();
  const ta = await adminGiris(o);
  await o.istek('POST', 'products/import', { urunler: URUNLER }, ta);
  const ayse = await personelHazirla(o, ta, 'ayse', 'Ayşe');
  const yol = 'products/1001/sayim';
  assert.equal((await o.istek('POST', yol, { yeni: 35 }, ayse.token)).status, 400);
  assert.equal((await o.istek('POST', yol, { yeni: -1, neden: 'Sayım farkı' }, ayse.token)).status, 400);
  assert.equal((await o.istek('POST', yol, { yeni: 40, neden: 'Sayım farkı' }, ayse.token)).status, 400);
  assert.equal((await o.istek('POST', 'products/yok/sayim', { yeni: 5, neden: 'Sayım farkı' }, ayse.token)).status, 404);
  const r = await o.istek('POST', yol, { yeni: 35, neden: 'Sayım farkı' }, ayse.token);
  assert.equal(r.status, 200);
  assert.equal(r.veri.stok, 35);
  assert.equal(JSON.stringify(r.veri).includes('alis'), false);

  const kendi = (await o.istek('GET', 'stock-moves', null, ayse.token)).veri;
  assert.equal(kendi.length, 1);
  assert.equal(kendi[0].fark, -5);
  assert.equal(kendi[0].user.name, 'Ayşe');
  // yönetici tüm hareketleri görür; ürün düzenlemesi de kayıt bırakır
  await o.istek('PUT', 'products/1001', { stok: 50 }, ta);
  const hepsi = (await o.istek('GET', 'stock-moves', null, ta)).veri;
  assert.equal(hepsi.length, 2);
  assert.equal(hepsi[0].tur, 'duzeltme');
  // personel başkasının hareketini görmez
  assert.equal((await o.istek('GET', 'stock-moves', null, ayse.token)).veri.length, 1);
  assert.equal((await o.istek('GET', 'stock-moves?barkod=1002', null, ta)).veri.length, 0);
});

test('iş doğrulamaları', async () => {
  const o = yeniOrtam();
  const ta = await adminGiris(o);
  assert.equal((await o.istek('POST', 'jobs', { baslik: 'A', termin: '01.11.2026' }, ta)).status, 400);
  const j = (await o.istek('POST', 'jobs', { baslik: 'A', tur: 'bilinmeyen', oncelik: 'x' }, ta)).veri;
  assert.equal(j.tur, 'servis');
  assert.equal(j.oncelik, 'normal');
  assert.equal((await o.istek('POST', `jobs/${j.id}/durum`, { durum: 'bozuk' }, ta)).status, 400);
  assert.equal((await o.istek('POST', `jobs/${j.id}/durum`, { durum: 'iptal' }, ta)).veri.durum, 'iptal');
  assert.equal((await o.istek('GET', 'jobs/yok', null, ta)).status, 404);
});

test('muhasebe: gider defteri ve aylık hesap', async () => {
  const o = yeniOrtam();
  const ta = await adminGiris(o);
  await o.istek('POST', 'products/import', { urunler: URUNLER }, ta);
  await o.istek('POST', 'users', { username: 'ayse', name: 'Ayşe Yılmaz', password: 'personel123', role: 'staff' }, ta);
  const ayse = (await o.istek('POST', 'login', { username: 'ayse', password: 'personel123' })).veri;
  const ay = new Date(Date.now() + 3 * 36e5).toISOString().slice(0, 7);
  const bugun = ay + '-15';
  // personel muhasebeye erişemez
  assert.equal((await o.istek('GET', `accounting/summary?ay=${ay}`, null, ayse.token)).status, 403);
  assert.equal((await o.istek('POST', 'accounting/expenses', { tarih: bugun, tur: 'maas', tutar: 1 }, ayse.token)).status, 403);
  // doğrulamalar
  assert.equal((await o.istek('POST', 'accounting/expenses', { tarih: '15.10.2026', tur: 'maas', tutar: 100 }, ta)).status, 400);
  assert.equal((await o.istek('POST', 'accounting/expenses', { tarih: bugun, tur: 'bilinmeyen', tutar: 100 }, ta)).status, 400);
  assert.equal((await o.istek('POST', 'accounting/expenses', { tarih: bugun, tur: 'maas', tutar: 0 }, ta)).status, 400);
  assert.equal((await o.istek('POST', 'accounting/expenses', { tarih: '2026-02-31', tur: 'maas', tutar: 5 }, ta)).status, 400);
  // iş: ücret 1500, parça 2x245=490, masraf 120, tamamlandı
  const j = (await o.istek('POST', 'jobs', { baslik: 'Kurulum', ucret: 1500, atanan: ayse.user ? ayse.user.id : undefined }, ta)).veri;
  await o.istek('POST', `jobs/${j.id}/parts`, { barkod: '1001', adet: 2 }, ta);
  await o.istek('POST', `jobs/${j.id}/costs`, { aciklama: 'Yol', tutar: 120, tur: 'yol' }, ta);
  await o.istek('POST', `jobs/${j.id}/durum`, { durum: 'tamam' }, ta);
  // satış: 1 adet 450 (alış 245)
  await o.istek('POST', 'sales', { mod: 'perakende', satirlar: [{ barkod: '1001', adet: 1 }] }, ta);
  // genel giderler
  await o.istek('POST', 'accounting/expenses', { tarih: bugun, tur: 'maas', tutar: 10000, kisi: 'Ayşe Yılmaz', aciklama: 'Ay maaşı' }, ta);
  await o.istek('POST', 'accounting/expenses', { tarih: bugun, tur: 'kira', tutar: 5000 }, ta);
  const stok = (await o.istek('POST', 'accounting/expenses', { tarih: bugun, tur: 'stok_alim', tutar: 20000 }, ta)).veri;
  const liste = (await o.istek('GET', `accounting/expenses?ay=${ay}`, null, ta)).veri;
  assert.equal(liste.length, 3);
  const h = (await o.istek('GET', `accounting/summary?ay=${ay}`, null, ta)).veri;
  assert.equal(h.gelir.satis, 450);
  assert.equal(h.gelir.is, 1500);
  assert.equal(h.gelir.toplam, 1950);
  assert.equal(h.gider.urun, 245);
  assert.equal(h.gider.isParca, 490);
  assert.equal(h.gider.isMasraf, 120);
  assert.equal(h.gider.genelToplam, 15000);
  assert.equal(h.gider.genel.maas, 10000);
  assert.equal(h.stokAlim, 20000);               // kâra dahil değil
  assert.equal(h.gider.toplam, 245 + 490 + 120 + 15000);
  assert.equal(h.net, 1950 - 15855);
  assert.equal(h.maasKisi['Ayşe Yılmaz'], 10000);
  // yıllık tablo 12 ay döner
  const yil = (await o.istek('GET', `accounting/year?yil=${ay.slice(0, 4)}`, null, ta)).veri;
  assert.equal(yil.length, 12);
  assert.equal(yil.find((x) => x.ay === ay).net, h.net);
  // silme
  assert.equal((await o.istek('DELETE', `accounting/expenses/${stok.id}?ay=${ay}`, null, ta)).status, 200);
  assert.equal((await o.istek('GET', `accounting/summary?ay=${ay}`, null, ta)).veri.stokAlim, 0);
  assert.equal((await o.istek('GET', 'accounting/summary?ay=bozuk', null, ta)).status, 400);
});
