// Arıtma Stok Paneli - sunucu tarafı
// Depolama ve ortam değişkenleri dışarıdan verilir; böylece Netlify dışında test edilebilir.
import crypto from 'node:crypto';

const OTURUM_SN = 12 * 3600;
const KANAL_IDLERI = ['trendyol', 'hepsiburada', 'n11', 'amazon', 'ciceksepeti'];
const VARSAYILAN_AYAR = {
  kargo: 60, paket: 10, kdvAcik: false, kdv: 20, toptanMarj: 12,
  kom: { trendyol: 15, hepsiburada: 15, n11: 12, amazon: 12, ciceksepeti: 15 },
  bag: {}
};

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
});
const hata = (status, mesaj) => json({ hata: mesaj }, status);
const bekle = (ms) => new Promise((r) => setTimeout(r, ms));
const r2 = (n) => Math.round(n * 100) / 100;
const uid = () => crypto.randomBytes(9).toString('base64url');

function sayi(v, min = 0, max = 1e9) {
  if (v === null || v === undefined || v === '') return NaN;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : NaN;
}

/* ---------- şifre ve oturum ---------- */
function sifreHashle(sifre, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(sifre, salt, 64).toString('hex') };
}
function sifreDogru(sifre, kullanici) {
  const h = crypto.scryptSync(sifre, kullanici.salt, 64);
  const e = Buffer.from(kullanici.hash, 'hex');
  return h.length === e.length && crypto.timingSafeEqual(h, e);
}
function esitMi(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}
function tokenUret(yuk, secret) {
  const govde = Buffer.from(JSON.stringify(yuk)).toString('base64url');
  const imza = crypto.createHmac('sha256', secret).update(govde).digest('base64url');
  return govde + '.' + imza;
}
function tokenCoz(token, secret) {
  if (!token || !token.includes('.')) return null;
  const [govde, imza] = token.split('.');
  const beklenen = crypto.createHmac('sha256', secret).update(govde).digest('base64url');
  const a = Buffer.from(imza || '');
  const b = Buffer.from(beklenen);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const yuk = JSON.parse(Buffer.from(govde, 'base64url').toString());
    return yuk.exp > Date.now() / 1000 ? yuk : null;
  } catch { return null; }
}

/* ---------- görünümler (rol bazlı veri gizleme) ---------- */
const kullaniciGorunum = (u) => ({
  id: u.id, username: u.username, name: u.name, role: u.role, active: u.active,
  created: u.created, lastLogin: u.lastLogin || null
});
const urunGorunum = (u, yonetici) => yonetici ? u : {
  barkod: u.barkod, ad: u.ad, kategori: u.kategori, perakende: u.perakende,
  toptan: u.toptan, stok: u.stok, min: u.min
};
const satisGorunum = (s, yonetici) => yonetici ? s : {
  id: s.id, t: s.t, mod: s.mod, kanal: s.kanal, musteri: s.musteri, user: s.user,
  satirlar: s.satirlar.map((l) => ({ barkod: l.barkod, ad: l.ad, adet: l.adet, fiyat: l.fiyat })),
  ciro: s.ciro
};

/* ---------- ürün doğrulama ---------- */
function urunTemizle(o, ayar) {
  const barkod = String(o.barkod ?? '').trim();
  if (!/^[A-Za-z0-9._-]{1,32}$/.test(barkod)) return { hata: 'Barkod geçersiz (1-32 harf veya rakam)' };
  const ad = String(o.ad ?? '').trim().slice(0, 200);
  if (!ad) return { hata: 'Ürün adı boş' };
  const alis = sayi(o.alis);
  if (Number.isNaN(alis)) return { hata: 'Alış fiyatı geçersiz' };
  const perakende = sayi(o.perakende);
  if (Number.isNaN(perakende)) return { hata: 'Perakende fiyatı geçersiz' };
  let toptan = sayi(o.toptan);
  if (!(toptan > 0)) toptan = r2(alis * (1 + ayar.toptanMarj / 100));
  const stok = sayi(o.stok);
  const min = sayi(o.min);
  return {
    urun: {
      barkod, ad,
      kategori: String(o.kategori ?? '').trim().slice(0, 80),
      alis: r2(alis), perakende: r2(perakende), toptan: r2(toptan),
      stok: Number.isNaN(stok) ? null : Math.round(stok),
      min: Number.isNaN(min) ? null : Math.round(min)
    }
  };
}

export function createHandler({ store, env }) {
  const ortam = env || {};

  const kullanicilariOku = async () => (await store.get('users')) || [];
  const urunleriOku = async () => (await store.get('products')) || [];
  async function ayarOku() {
    const k = (await store.get('settings')) || {};
    return {
      ...VARSAYILAN_AYAR, ...k,
      kom: { ...VARSAYILAN_AYAR.kom, ...(k.kom || {}) },
      bag: { ...(k.bag || {}) }
    };
  }
  async function govde(req) {
    try { return (await req.json()) || {}; } catch { return {}; }
  }

  return async function handler(req) {
    try { return await yonlendir(req); }
    catch (e) { console.error(e); return hata(500, 'Sunucu hatası'); }
  };

  async function yonlendir(req) {
    const url = new URL(req.url);
    const parcalar = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
    const yontem = req.method;
    const [a, b] = parcalar;

    const secret = ortam.JWT_SECRET;
    if (!secret || secret.length < 16) {
      return hata(500, 'Kurulum eksik: JWT_SECRET ortam değişkeni tanımlı değil (en az 16 karakter).');
    }

    if (a === 'durum' && yontem === 'GET') {
      const k = await kullanicilariOku();
      return json({ kurulumGerekli: k.length === 0, adminSifreTanimli: Boolean(ortam.ADMIN_PASSWORD) });
    }
    if (a === 'login' && yontem === 'POST') return girisYap(req, secret);

    const user = await oturumuBul(req, secret);
    if (!user) return hata(401, 'Oturum gerekli');
    const yonetici = user.role === 'admin';
    const yetkiYok = () => hata(403, 'Bu işlem için yönetici yetkisi gerekir');

    if (a === 'me') {
      if (!b && yontem === 'GET') return json(kullaniciGorunum(user));
      if (b === 'password' && yontem === 'POST') return sifreDegistir(req, user);
    }
    if (a === 'products') {
      if (!b && yontem === 'GET') {
        const l = await urunleriOku();
        return json(l.map((u) => urunGorunum(u, yonetici)));
      }
      if (!yonetici) return yetkiYok();
      if (!b && yontem === 'POST') return urunEkle(req);
      if (b === 'import' && yontem === 'POST') return icAktar(req);
      if (b && yontem === 'PUT') return urunGuncelle(req, b);
      if (b && yontem === 'DELETE') return urunSil(b);
    }
    if (a === 'sales') {
      if (!b && yontem === 'GET') return satisListele(url, user);
      if (!b && yontem === 'POST') return satisYap(req, user);
    }
    if (a === 'settings') {
      if (!yonetici) return yetkiYok();
      if (yontem === 'GET') return json(await ayarOku());
      if (yontem === 'PUT') return ayarKaydet(req);
    }
    if (a === 'users') {
      if (!yonetici) return yetkiYok();
      if (!b && yontem === 'GET') return json((await kullanicilariOku()).map(kullaniciGorunum));
      if (!b && yontem === 'POST') return kullaniciEkle(req);
      if (b && yontem === 'PATCH') return kullaniciGuncelle(req, b, user);
      if (b && yontem === 'DELETE') return kullaniciSil(b, user);
    }
    return hata(404, 'Bulunamadı');
  }

  /* ---------- oturum ---------- */
  async function oturumuBul(req, secret) {
    const baslik = req.headers.get('authorization') || '';
    const token = baslik.startsWith('Bearer ') ? baslik.slice(7) : '';
    const yuk = tokenCoz(token, secret);
    if (!yuk) return null;
    const u = (await kullanicilariOku()).find((x) => x.id === yuk.uid);
    return u && u.active ? u : null;
  }

  async function girisYap(req, secret) {
    const b = await govde(req);
    const kadi = String(b.username || '').trim().toLowerCase();
    const sifre = String(b.password || '');
    let kullanicilar = await kullanicilariOku();

    // İlk kurulum: kullanıcı yoksa ortam değişkenindeki yönetici bilgisiyle ilk hesap açılır.
    if (!kullanicilar.length && ortam.ADMIN_PASSWORD) {
      const kadiBeklenen = String(ortam.ADMIN_USERNAME || 'admin').trim().toLowerCase();
      if (kadi === kadiBeklenen && esitMi(sifre, ortam.ADMIN_PASSWORD)) {
        const { salt, hash } = sifreHashle(sifre);
        kullanicilar = [{
          id: uid(), username: kadi, name: 'Yönetici', role: 'admin', active: true,
          salt, hash, created: new Date().toISOString()
        }];
        await store.set('users', kullanicilar);
      }
    }
    const u = kullanicilar.find((x) => x.username === kadi && x.active);
    if (!u || !sifreDogru(sifre, u)) {
      await bekle(500);
      return hata(401, 'Kullanıcı adı veya şifre hatalı');
    }
    u.lastLogin = new Date().toISOString();
    await store.set('users', kullanicilar);
    const token = tokenUret({ uid: u.id, exp: Math.floor(Date.now() / 1000) + OTURUM_SN }, secret);
    return json({ token, user: kullaniciGorunum(u) });
  }

  async function sifreDegistir(req, user) {
    const b = await govde(req);
    const eski = String(b.eski || '');
    const yeni = String(b.yeni || '');
    if (yeni.length < 8 || yeni.length > 100) return hata(400, 'Yeni şifre en az 8 karakter olmalı');
    const kullanicilar = await kullanicilariOku();
    const u = kullanicilar.find((x) => x.id === user.id);
    if (!u || !sifreDogru(eski, u)) { await bekle(500); return hata(400, 'Mevcut şifre hatalı'); }
    Object.assign(u, sifreHashle(yeni));
    await store.set('users', kullanicilar);
    return json({ tamam: true });
  }

  /* ---------- personel ---------- */
  async function kullaniciEkle(req) {
    const b = await govde(req);
    const kadi = String(b.username || '').trim().toLowerCase();
    const ad = String(b.name || '').trim().slice(0, 60);
    const sifre = String(b.password || '');
    const rol = b.role === 'admin' ? 'admin' : 'staff';
    if (!/^[a-z0-9._-]{3,32}$/.test(kadi)) return hata(400, 'Kullanıcı adı 3-32 karakter olmalı; küçük harf, rakam, nokta, tire veya alt çizgi kullanın');
    if (!ad) return hata(400, 'Ad soyad gerekli');
    if (sifre.length < 8 || sifre.length > 100) return hata(400, 'Şifre en az 8 karakter olmalı');
    const kullanicilar = await kullanicilariOku();
    if (kullanicilar.some((x) => x.username === kadi)) return hata(409, 'Bu kullanıcı adı zaten var');
    const yeni = {
      id: uid(), username: kadi, name: ad, role: rol, active: true,
      ...sifreHashle(sifre), created: new Date().toISOString()
    };
    kullanicilar.push(yeni);
    await store.set('users', kullanicilar);
    return json(kullaniciGorunum(yeni), 201);
  }

  const aktifYoneticiSayisi = (l) => l.filter((x) => x.role === 'admin' && x.active).length;

  async function kullaniciGuncelle(req, id, ben) {
    const b = await govde(req);
    const kullanicilar = await kullanicilariOku();
    const u = kullanicilar.find((x) => x.id === id);
    if (!u) return hata(404, 'Kullanıcı bulunamadı');
    const yeniRol = b.role === undefined ? u.role : (b.role === 'admin' ? 'admin' : 'staff');
    const yeniAktif = b.active === undefined ? u.active : Boolean(b.active);
    if (u.id === ben.id && (yeniRol !== 'admin' || !yeniAktif)) {
      return hata(409, 'Kendi yönetici yetkinizi veya hesabınızı kapatamazsınız');
    }
    if (u.role === 'admin' && u.active && (yeniRol !== 'admin' || !yeniAktif) && aktifYoneticiSayisi(kullanicilar) <= 1) {
      return hata(409, 'Son aktif yönetici değiştirilemez');
    }
    if (b.name !== undefined) {
      const ad = String(b.name).trim().slice(0, 60);
      if (!ad) return hata(400, 'Ad soyad boş olamaz');
      u.name = ad;
    }
    if (b.password !== undefined) {
      const s = String(b.password);
      if (s.length < 8 || s.length > 100) return hata(400, 'Şifre en az 8 karakter olmalı');
      Object.assign(u, sifreHashle(s));
    }
    u.role = yeniRol;
    u.active = yeniAktif;
    await store.set('users', kullanicilar);
    return json(kullaniciGorunum(u));
  }

  async function kullaniciSil(id, ben) {
    const kullanicilar = await kullanicilariOku();
    const u = kullanicilar.find((x) => x.id === id);
    if (!u) return hata(404, 'Kullanıcı bulunamadı');
    if (u.id === ben.id) return hata(409, 'Kendi hesabınızı silemezsiniz');
    if (u.role === 'admin' && u.active && aktifYoneticiSayisi(kullanicilar) <= 1) {
      return hata(409, 'Son aktif yönetici silinemez');
    }
    await store.set('users', kullanicilar.filter((x) => x.id !== id));
    return json({ tamam: true });
  }

  /* ---------- ürünler ---------- */
  async function urunEkle(req) {
    const ayar = await ayarOku();
    const t = urunTemizle(await govde(req), ayar);
    if (t.hata) return hata(400, t.hata);
    const urunler = await urunleriOku();
    if (urunler.some((u) => u.barkod === t.urun.barkod)) return hata(409, 'Bu barkod zaten kayıtlı');
    const yeni = { ...t.urun, stok: t.urun.stok ?? 0, min: t.urun.min ?? 5 };
    urunler.push(yeni);
    await store.set('products', urunler);
    return json(yeni, 201);
  }

  async function urunGuncelle(req, barkod) {
    const ayar = await ayarOku();
    const urunler = await urunleriOku();
    const m = urunler.find((u) => u.barkod === barkod);
    if (!m) return hata(404, 'Ürün bulunamadı');
    const b = await govde(req);
    const degisen = Object.fromEntries(Object.entries(b).filter(([, v]) => v !== null && v !== undefined));
    const t = urunTemizle({ ...m, ...degisen, barkod }, ayar);
    if (t.hata) return hata(400, t.hata);
    Object.assign(m, t.urun, { stok: t.urun.stok ?? m.stok, min: t.urun.min ?? m.min });
    await store.set('products', urunler);
    return json(m);
  }

  async function urunSil(barkod) {
    const urunler = await urunleriOku();
    if (!urunler.some((u) => u.barkod === barkod)) return hata(404, 'Ürün bulunamadı');
    await store.set('products', urunler.filter((u) => u.barkod !== barkod));
    return json({ tamam: true });
  }

  async function icAktar(req) {
    const b = await govde(req);
    const liste = Array.isArray(b.urunler) ? b.urunler : null;
    if (!liste || liste.length > 3000) return hata(400, 'urunler listesi gerekli (en fazla 3000 satır)');
    const mod = b.mod === 'yaz' ? 'yaz' : 'ekle';
    const ayar = await ayarOku();
    const marj = sayi(b.toptanMarj, 0, 1000);
    if (!Number.isNaN(marj) && marj !== ayar.toptanMarj) {
      ayar.toptanMarj = marj;
      await store.set('settings', ayar);
    }
    const urunler = await urunleriOku();
    const dizin = new Map(urunler.map((u) => [u.barkod, u]));
    let yeni = 0; let guncel = 0;
    const hatalar = [];
    liste.forEach((o, i) => {
      const t = urunTemizle(o, ayar);
      if (t.hata) { hatalar.push({ satir: i + 1, hata: t.hata }); return; }
      const x = t.urun;
      const m = dizin.get(x.barkod);
      if (m) {
        m.ad = x.ad; if (x.kategori) m.kategori = x.kategori;
        m.alis = x.alis; m.perakende = x.perakende; m.toptan = x.toptan;
        if (x.stok !== null) m.stok = mod === 'ekle' ? m.stok + x.stok : x.stok;
        if (x.min !== null) m.min = x.min;
        guncel++;
      } else {
        const n = { ...x, stok: x.stok ?? 0, min: x.min ?? 5 };
        urunler.push(n); dizin.set(n.barkod, n); yeni++;
      }
    });
    await store.set('products', urunler);
    return json({ yeni, guncel, hataSayisi: hatalar.length, hatalar: hatalar.slice(0, 20), toplam: urunler.length });
  }

  /* ---------- satış ---------- */
  async function satisYap(req, user) {
    const yonetici = user.role === 'admin';
    const b = await govde(req);
    const mod = b.mod === 'toptan' ? 'toptan' : 'perakende';
    const musteri = String(b.musteri || '').trim().slice(0, 80);
    if (!Array.isArray(b.satirlar) || !b.satirlar.length || b.satirlar.length > 200) {
      return hata(400, 'Sepet boş veya çok büyük');
    }
    const toplam = new Map();
    for (const l of b.satirlar) {
      const bk = String((l && l.barkod) || '').trim();
      const adet = Math.round(sayi(l && l.adet, 0, 1e6));
      if (!bk || !(adet >= 1)) return hata(400, 'Sepet satırı geçersiz');
      toplam.set(bk, (toplam.get(bk) || 0) + adet);
    }
    const urunler = await urunleriOku();
    const dizin = new Map(urunler.map((u) => [u.barkod, u]));
    for (const [bk, adet] of toplam) {
      const u = dizin.get(bk);
      if (!u) return hata(404, `Barkod bulunamadı: ${bk}`);
      if (u.stok < adet) return hata(409, `${u.ad}: stokta yalnızca ${u.stok} adet var`);
    }
    const satirlar = []; const etkilenen = [];
    for (const [bk, adet] of toplam) {
      const u = dizin.get(bk);
      u.stok -= adet;
      etkilenen.push(u);
      satirlar.push({ barkod: u.barkod, ad: u.ad, adet, fiyat: mod === 'toptan' ? u.toptan : u.perakende, alis: u.alis });
    }
    const simdi = new Date().toISOString();
    const satis = {
      id: uid(), t: simdi, mod, kanal: 'magaza', musteri,
      user: { id: user.id, name: user.name },
      satirlar,
      ciro: r2(satirlar.reduce((a, s) => a + s.fiyat * s.adet, 0)),
      maliyet: r2(satirlar.reduce((a, s) => a + s.alis * s.adet, 0)),
      kom: 0, ek: 0
    };
    await store.set('products', urunler);
    const anahtar = 'sales:' + simdi.slice(0, 7);
    const ay = (await store.get(anahtar)) || [];
    ay.push(satis);
    await store.set(anahtar, ay);
    return json({ satis: satisGorunum(satis, yonetici), urunler: etkilenen.map((u) => urunGorunum(u, yonetici)) }, 201);
  }

  async function satisListele(url, user) {
    const yonetici = user.role === 'admin';
    const simdi = new Date();
    let bit = new Date(url.searchParams.get('to') || simdi.getTime() + 864e5);
    let bas = new Date(url.searchParams.get('from') || simdi.getTime() - 30 * 864e5);
    if (Number.isNaN(bit.getTime()) || Number.isNaN(bas.getTime())) return hata(400, 'Tarih geçersiz');
    const enEski = new Date(bit.getTime() - 731 * 864e5);
    if (bas < enEski) bas = enEski;
    const anahtarlar = [];
    let y = bas.getUTCFullYear(); let m = bas.getUTCMonth();
    const sy = bit.getUTCFullYear(); const sm = bit.getUTCMonth();
    while (y < sy || (y === sy && m <= sm)) {
      anahtarlar.push(`sales:${y}-${String(m + 1).padStart(2, '0')}`);
      m++; if (m > 11) { m = 0; y++; }
    }
    const aylar = await Promise.all(anahtarlar.map((k) => store.get(k)));
    let liste = aylar.flat().filter(Boolean).filter((s) => {
      const t = new Date(s.t).getTime();
      return t >= bas.getTime() && t <= bit.getTime();
    });
    if (!yonetici) liste = liste.filter((s) => s.user && s.user.id === user.id);
    liste.sort((p, q) => (p.t < q.t ? 1 : -1));
    const ust = yonetici ? 5000 : 50;
    const limit = Math.min(ust, Math.max(1, parseInt(url.searchParams.get('limit') || String(ust), 10) || ust));
    return json(liste.slice(0, limit).map((s) => satisGorunum(s, yonetici)));
  }

  /* ---------- ayarlar ---------- */
  async function ayarKaydet(req) {
    const b = await govde(req);
    const n = await ayarOku();
    for (const [k, min, max] of [['kargo', 0, 1e6], ['paket', 0, 1e6], ['kdv', 0, 100], ['toptanMarj', 0, 1000]]) {
      if (b[k] === undefined) continue;
      const v = sayi(b[k], min, max);
      if (Number.isNaN(v)) return hata(400, `${k} geçersiz`);
      n[k] = v;
    }
    if (b.kdvAcik !== undefined) n.kdvAcik = Boolean(b.kdvAcik);
    if (b.kom && typeof b.kom === 'object') {
      for (const id of KANAL_IDLERI) {
        if (b.kom[id] === undefined) continue;
        const v = sayi(b.kom[id], 0, 100);
        if (Number.isNaN(v)) return hata(400, `Komisyon geçersiz: ${id}`);
        n.kom[id] = v;
      }
    }
    if (b.bag && typeof b.bag === 'object') {
      for (const id of KANAL_IDLERI) {
        const x = b.bag[id];
        if (!x || typeof x !== 'object') continue;
        n.bag[id] = {
          durum: x.durum === 'taslak' ? 'taslak' : 'yok',
          stok: x.stok !== false, fiyat: x.fiyat !== false, siparis: x.siparis !== false
        };
      }
    }
    await store.set('settings', n);
    return json(n);
  }
}
