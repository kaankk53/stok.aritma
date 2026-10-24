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

test('finans: cari, kasa, tahsilat, fatura, stok etkisi, fiyat listesi', async () => {
  const o = yeniOrtam();
  const ta = await adminGiris(o);
  await o.istek('POST', 'products/import', { urunler: URUNLER }, ta);
  await o.istek('POST', 'users', { username: 'ayse', name: 'Ayşe', password: 'personel123', role: 'staff' }, ta);
  const ayse = (await o.istek('POST', 'login', { username: 'ayse', password: 'personel123' })).veri;
  // personel erişemez
  for (const yol of ['cariler', 'hesaplar', 'belgeler', 'odemeler', 'fiyat-listeleri', 'backup']) {
    assert.equal((await o.istek('GET', yol, null, ayse.token)).status, 403, yol);
  }
  // cari + kasa
  assert.equal((await o.istek('POST', 'cariler', { ad: '' }, ta)).status, 400);
  const m = (await o.istek('POST', 'cariler', { ad: 'Yıldız Apt.', tur: 'musteri', iskonto: 10 }, ta)).veri;
  const t = (await o.istek('POST', 'cariler', { ad: 'Filtre Toptan', tur: 'tedarikci' }, ta)).veri;
  assert.equal((await o.istek('POST', 'cariler', { ad: 'yıldız apt.' }, ta)).status, 409);
  const kasa = (await o.istek('POST', 'hesaplar', { ad: 'Kasa', tur: 'kasa', acilis: 1000 }, ta)).veri;
  const banka = (await o.istek('POST', 'hesaplar', { ad: 'Banka', tur: 'banka' }, ta)).veri;
  // satış faturası: 2 x 450 KDV dahil, %10 iskonto, stok düşer
  const sf = await o.istek('POST', 'belgeler', { tur: 'satis', cari: m.id, iskonto: 10, kdvDahil: true,
    satirlar: [{ barkod: '1001', adet: 2, fiyat: 450, kdv: 20 }, { ad: 'Montaj', adet: 1, fiyat: 600, kdv: 20 }] }, ta);
  assert.equal(sf.status, 201);
  // brüt 900+600=1500; net 1250; iskonto 125; kdv (1250*.2)*.9=225; toplam 1350
  assert.equal(sf.veri.ara, 1250); assert.equal(sf.veri.iskontoTutar, 125); assert.equal(sf.veri.kdvTutar, 225); assert.equal(sf.veri.toplam, 1350);
  assert.match(sf.veri.no, /^SF-\d{4}-0001$/);
  let urun = (await o.istek('GET', 'products', null, ta)).veri.find((x) => x.barkod === '1001');
  assert.equal(urun.stok, 38);
  // yetersiz stok
  assert.equal((await o.istek('POST', 'belgeler', { tur: 'satis', cari: m.id, satirlar: [{ barkod: '1001', adet: 999, fiyat: 1, kdv: 20 }] }, ta)).status, 400);
  // cari bakiye: müşteri 1350 borçlu
  let cariler = (await o.istek('GET', 'cariler', null, ta)).veri;
  assert.equal(cariler.find((x) => x.id === m.id).bakiye, 1350);
  // tahsilat 500 kasaya
  const th = await o.istek('POST', 'odemeler', { tur: 'tahsilat', cari: m.id, hesap: kasa.id, tutar: 500 }, ta);
  assert.equal(th.status, 201);
  cariler = (await o.istek('GET', 'cariler', null, ta)).veri;
  assert.equal(cariler.find((x) => x.id === m.id).bakiye, 850);
  let hesaplar = (await o.istek('GET', 'hesaplar', null, ta)).veri;
  assert.equal(hesaplar.find((x) => x.id === kasa.id).bakiye, 1500);
  // alış faturası peşin ödemeli: stok artar, banka düşer, alış fiyatı güncellenir
  await o.istek('POST', 'hesaplar/' + banka.id + '/duzeltme', { tutar: 5000, aciklama: 'Açılış sayımı' }, ta);
  const af = await o.istek('POST', 'belgeler', { tur: 'alis', cari: t.id, kdvDahil: false, alisGuncelle: true, odenen: 1000, hesap: banka.id,
    satirlar: [{ barkod: '1002', adet: 100, fiyat: 30, kdv: 20 }] }, ta);
  assert.equal(af.status, 201);
  assert.equal(af.veri.toplam, 3600);
  urun = (await o.istek('GET', 'products', null, ta)).veri.find((x) => x.barkod === '1002');
  assert.equal(urun.stok, 300); assert.equal(urun.alis, 30);
  cariler = (await o.istek('GET', 'cariler', null, ta)).veri;
  assert.equal(cariler.find((x) => x.id === t.id).bakiye, -2600);   // 3600 alış - 1000 ödeme, biz borçluyuz
  hesaplar = (await o.istek('GET', 'hesaplar', null, ta)).veri;
  assert.equal(hesaplar.find((x) => x.id === banka.id).bakiye, 4000);
  // ekstre
  const ek = (await o.istek('GET', `cariler/${m.id}/ekstre`, null, ta)).veri;
  assert.equal(ek.hareketler.length, 2); assert.equal(ek.hareketler[1].bakiye, 850);
  // transfer
  assert.equal((await o.istek('POST', 'hesaplar/transfer', { kaynak: kasa.id, hedef: banka.id, tutar: 300 }, ta)).status, 200);
  hesaplar = (await o.istek('GET', 'hesaplar', null, ta)).veri;
  assert.equal(hesaplar.find((x) => x.id === kasa.id).bakiye, 1200); assert.equal(hesaplar.find((x) => x.id === banka.id).bakiye, 4300);
  // gider -> hesap
  const ay = new Date(Date.now() + 3 * 36e5).toISOString().slice(0, 7);
  await o.istek('POST', 'accounting/expenses', { tarih: ay + '-10', tur: 'kira', tutar: 200, hesap: kasa.id }, ta);
  assert.equal(((await o.istek('GET', 'hesaplar', null, ta)).veri).find((x) => x.id === kasa.id).bakiye, 1000);
  // muhasebe: fatura geliri (net 1125) ve maliyeti (2 x 245 = 490)
  const h = (await o.istek('GET', `accounting/summary?ay=${ay}`, null, ta)).veri;
  assert.equal(h.gelir.fatura, 1125); assert.equal(h.gider.urun, 490);
  // iptal: stok geri gelir, cari sıfırlanır (tahsilat ayrı kayıt kalır)
  const ip = await o.istek('POST', `belgeler/${sf.veri.id}/iptal`, null, ta);
  assert.equal(ip.veri.durum, 'iptal');
  urun = (await o.istek('GET', 'products', null, ta)).veri.find((x) => x.barkod === '1001');
  assert.equal(urun.stok, 40);
  assert.equal((await o.istek('POST', `belgeler/${sf.veri.id}/iptal`, null, ta)).status, 400);
  // dolu cari silinemez
  assert.equal((await o.istek('DELETE', 'cariler/' + m.id, null, ta)).status, 400);
  // tahsilat silinince kasa geri döner
  await o.istek('DELETE', 'odemeler/' + th.veri.id, null, ta);
  assert.equal(((await o.istek('GET', 'hesaplar', null, ta)).veri).find((x) => x.id === kasa.id).bakiye, 500);
  // fiyat listesi
  const fl = (await o.istek('POST', 'fiyat-listeleri', { ad: 'Bayi', kaynak: 'toptan', yuzde: -5, ozel: { 1002: 50 } }, ta)).veri;
  assert.equal((await o.istek('GET', `fiyat-listeleri/hesapla?liste=${fl.id}&barkod=1001`, null, ta)).veri.fiyat, 313.5);
  assert.equal((await o.istek('GET', `fiyat-listeleri/hesapla?liste=${fl.id}&barkod=1002`, null, ta)).veri.fiyat, 50);
  assert.equal((await o.istek('POST', 'fiyat-listeleri', { ad: 'X', kaynak: 'bozuk' }, ta)).status, 400);
  // yedek
  const y = await o.istek('POST', 'backup/run', null, ta);
  assert.equal(y.status, 200);
  const liste = (await o.istek('GET', 'backup', null, ta)).veri; assert.equal(liste.length, 1);
  const yed = (await o.istek('GET', 'backup/' + liste[0].tarih, null, ta)).veri;
  assert.ok(yed.veri.cariler.length === 2 && yed.veri.products.length === 2);
  assert.ok(!JSON.stringify(yed).includes('"hash"'));
});

test('finans: barkodlu satış kasaya işlenir', async () => {
  const o = yeniOrtam();
  const ta = await adminGiris(o);
  await o.istek('POST', 'products/import', { urunler: URUNLER }, ta);
  const kasa = (await o.istek('POST', 'hesaplar', { ad: 'Kasa' }, ta)).veri;
  await o.istek('PUT', 'settings', { satisHesap: kasa.id }, ta);
  await o.istek('POST', 'sales', { mod: 'perakende', satirlar: [{ barkod: '1002', adet: 2 }] }, ta);
  assert.equal(((await o.istek('GET', 'hesaplar', null, ta)).veri)[0].bakiye, 130);
});

test('siparişler: durum akışı stok ve ciroya işlenir, iptalde geri alınır', async () => {
  const o = yeniOrtam();
  const ta = await adminGiris(o);
  await o.istek('POST', 'products/import', { urunler: URUNLER }, ta);
  await o.istek('POST', 'users', { username: 'ayse', name: 'Ayşe', password: 'personel123', role: 'staff' }, ta);
  const ayse = (await o.istek('POST', 'login', { username: 'ayse', password: 'personel123' })).veri;
  assert.equal((await o.istek('GET', 'orders', null, ayse.token)).status, 403);
  assert.equal((await o.istek('POST', 'orders', { kanal: 'bozuk', satirlar: [] }, ta)).status, 400);
  const s = (await o.istek('POST', 'orders', { kanal: 'trendyol', harici: 'TY-123', musteri: 'Ali', satirlar: [{ barkod: '1001', adet: 2, fiyat: 450 }] }, ta)).veri;
  assert.match(s.no, /^SP-\d{4}-0001$/); assert.equal(s.tutar, 900); assert.equal(s.durum, 'bekliyor');
  // bekleyen sipariş stoğa dokunmaz
  assert.equal((await o.istek('GET', 'products', null, ta)).veri.find((x) => x.barkod === '1001').stok, 40);
  let p = (await o.istek('GET', 'accounting/dashboard', null, ta)).veri;
  assert.equal(p.uyari.bekleyenSiparis, 1); assert.equal(p.ay.eticaret, 0);
  // kargoya ver -> stok 38, e-ticaret cirosu 900, komisyon %15
  assert.equal((await o.istek('POST', `orders/${s.id}/durum`, { durum: 'kargoda' }, ta)).status, 200);
  assert.equal((await o.istek('GET', 'products', null, ta)).veri.find((x) => x.barkod === '1001').stok, 38);
  p = (await o.istek('GET', 'accounting/dashboard', null, ta)).veri;
  assert.equal(p.ay.eticaret, 900); assert.equal(p.ay.eticaretAdet, 1); assert.equal(p.uyari.bekleyenSiparis, 0);
  assert.equal(p.ay.eticaretNet, 900 - 490 - 135 - 70);
  assert.equal(p.bugun.satis, 900);
  // teslim: ikinci kez satış oluşmaz
  await o.istek('POST', `orders/${s.id}/durum`, { durum: 'teslim' }, ta);
  assert.equal((await o.istek('GET', 'products', null, ta)).veri.find((x) => x.barkod === '1001').stok, 38);
  // silinemez, iptalde geri alınır
  assert.equal((await o.istek('DELETE', `orders/${s.id}`, null, ta)).status, 400);
  await o.istek('POST', `orders/${s.id}/durum`, { durum: 'iptal' }, ta);
  assert.equal((await o.istek('GET', 'products', null, ta)).veri.find((x) => x.barkod === '1001').stok, 40);
  p = (await o.istek('GET', 'accounting/dashboard', null, ta)).veri;
  assert.equal(p.ay.eticaret, 0);
  // yetersiz stok
  const b = (await o.istek('POST', 'orders', { kanal: 'amazon', satirlar: [{ barkod: '1001', adet: 999, fiyat: 450 }] }, ta)).veri;
  assert.equal((await o.istek('POST', `orders/${b.id}/durum`, { durum: 'kargoda' }, ta)).status, 409);
  assert.equal((await o.istek('DELETE', `orders/${b.id}`, null, ta)).status, 200);
});

test('vade analizi: geciken tahsilat ve ödeme, cari detay', async () => {
  const o = yeniOrtam();
  const ta = await adminGiris(o);
  await o.istek('POST', 'products/import', { urunler: URUNLER }, ta);
  const kasa = (await o.istek('POST', 'hesaplar', { ad: 'Kasa' }, ta)).veri;
  const m = (await o.istek('POST', 'cariler', { ad: 'Demir Ailesi', vadeGun: 15 }, ta)).veri;
  assert.equal(m.vadeGun, 15);
  const t = (await o.istek('POST', 'cariler', { ad: 'Toptancı', tur: 'tedarikci' }, ta)).veri;
  const gun = (n) => new Date(Date.now() + 3 * 36e5 + n * 864e5).toISOString().slice(0, 10);
  // eski (vadesi geçmiş) iki satış faturası + vadesi gelmemiş bir fatura
  const f1 = (await o.istek('POST', 'belgeler', { tur: 'satis', cari: m.id, tarih: gun(-40), vade: gun(-10), kdvDahil: false, stokIslem: false, satirlar: [{ ad: 'Servis', adet: 1, fiyat: 1000, kdv: 0 }] }, ta)).veri;
  await o.istek('POST', 'belgeler', { tur: 'satis', cari: m.id, tarih: gun(-20), vade: gun(-2), kdvDahil: false, stokIslem: false, satirlar: [{ ad: 'Montaj', adet: 1, fiyat: 500, kdv: 0 }] }, ta);
  await o.istek('POST', 'belgeler', { tur: 'satis', cari: m.id, tarih: gun(0), vade: gun(10), kdvDahil: false, stokIslem: false, satirlar: [{ ad: 'Bakım', adet: 1, fiyat: 300, kdv: 0 }] }, ta);
  // 400 tahsilat: en eski faturadan düşer (kalan 600)
  await o.istek('POST', 'odemeler', { tur: 'tahsilat', cari: m.id, hesap: kasa.id, tutar: 400 }, ta);
  // tedarikçiye vadesi geçmiş alış faturası
  await o.istek('POST', 'belgeler', { tur: 'alis', cari: t.id, tarih: gun(-30), vade: gun(-5), kdvDahil: false, stokIslem: false, satirlar: [{ ad: 'Parça', adet: 1, fiyat: 2000, kdv: 0 }] }, ta);
  const d = (await o.istek('GET', `cariler/${m.id}/detay`, null, ta)).veri;
  assert.equal(d.bakiye, 1400); assert.equal(d.toplamAlis, 1800); assert.equal(d.alisSayisi, 3);
  assert.equal(d.acikAlacak.length, 3); assert.equal(d.acikAlacak[0].kalan, 600); assert.equal(d.acikAlacak[0].gecikmeGun, 10);
  assert.equal(d.geciken, 1100);          // 600 + 500, vadesi gelmemiş 300 hariç
  assert.ok(d.urunler.find((x) => x.ad === 'Servis'));
  const liste = (await o.istek('GET', 'cariler', null, ta)).veri.find((x) => x.id === m.id);
  assert.equal(liste.geciken, 1100); assert.equal(liste.sonAlis, gun(0));
  const p = (await o.istek('GET', 'accounting/dashboard', null, ta)).veri.uyari;
  assert.equal(p.gecikenTahsilat.adet, 2); assert.equal(p.gecikenTahsilat.tutar, 1100);
  assert.equal(p.gecikenOdeme.adet, 1); assert.equal(p.gecikenOdeme.tutar, 2000);
  assert.equal(p.toplamAlacak, 1400); assert.equal(p.toplamBorc, 2000);
  // fatura iptal edilince kalemden düşer
  await o.istek('POST', `belgeler/${f1.id}/iptal`, null, ta);
  assert.equal((await o.istek('GET', 'accounting/dashboard', null, ta)).veri.uyari.gecikenTahsilat.tutar, 100);   // 400 tahsilat kalan 500'ün ilk 400'ünü kapatır
});
