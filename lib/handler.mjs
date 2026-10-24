// Arıtma Stok Paneli - sunucu tarafı
// Depolama ve ortam değişkenleri dışarıdan verilir; böylece Netlify dışında test edilebilir.
import crypto from 'node:crypto';
import { finansKur } from './finans.mjs';
import { siparisKur } from './siparis.mjs';

const OTURUM_SN = 12 * 3600;
const KANAL_IDLERI = ['trendyol', 'hepsiburada', 'n11', 'amazon', 'ciceksepeti'];
const IS_TURLERI = ['kurulum', 'filtre', 'servis', 'teslimat', 'diger'];
const MASRAF_TURLERI = ['malzeme', 'yol', 'iscilik', 'diger'];
const DURUMLAR = ['bekliyor', 'devam', 'tamam', 'iptal'];
// stok_alim: nakit çıkışıdır, kâra dahil edilmez (satılınca ürün maliyeti olarak zaten düşülür)
const GIDER_AD = { maas: 'Maaş', kira: 'Kira', fatura: 'Fatura', yakit: 'Yakıt / araç', vergi: 'Vergi / SGK', reklam: 'Reklam', diger: 'Diğer', stok_alim: 'Stok alımı' };
const GIDER_TURLERI = ['maas', 'kira', 'fatura', 'yakit', 'vergi', 'reklam', 'diger', 'stok_alim'];
const VARSAYILAN_AYAR = {
  kargo: 60, paket: 10, kdvAcik: false, kdv: 20, toptanMarj: 12, satisHesap: null,
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
function isOzet(j) {
  const parca = r2(j.parcalar.reduce((a, p) => a + p.alis * p.adet, 0));
  const masraf = r2(j.masraflar.reduce((a, m) => a + m.tutar, 0));
  return { parca, masraf, maliyet: r2(parca + masraf), kar: r2(j.ucret - parca - masraf) };
}
function isGorunum(j, yonetici, adlar) {
  const temel = { ...j, atananAd: j.atanan ? (adlar.get(j.atanan) || '(silinmiş kullanıcı)') : '' };
  if (yonetici) return { ...temel, ozet: isOzet(j) };
  return {
    ...temel,
    parcalar: j.parcalar.map((p) => ({ id: p.id, t: p.t, user: p.user, barkod: p.barkod, ad: p.ad, adet: p.adet }))
  };
}

/* ---------- doğrulama ---------- */
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

function isTemizle(o) {
  const baslik = String(o.baslik ?? '').trim().slice(0, 120);
  if (!baslik) return { hata: 'İş başlığı gerekli' };
  const tur = IS_TURLERI.includes(o.tur) ? o.tur : 'servis';
  const oncelik = o.oncelik === 'acil' ? 'acil' : 'normal';
  const termin = String(o.termin ?? '').trim();
  if (termin && !/^\d{4}-\d{2}-\d{2}$/.test(termin)) return { hata: 'Termin tarihi geçersiz' };
  let ucret = sayi(o.ucret, 0, 1e8);
  if (Number.isNaN(ucret)) ucret = 0;
  return {
    is: {
      baslik, tur, oncelik, termin, ucret: r2(ucret),
      musteri: String(o.musteri ?? '').trim().slice(0, 80),
      telefon: String(o.telefon ?? '').trim().slice(0, 30),
      adres: String(o.adres ?? '').trim().slice(0, 200),
      aciklama: String(o.aciklama ?? '').trim().slice(0, 1000)
    }
  };
}

export function createHandler({ store, env }) {
  const ortam = env || {};

  const kullanicilariOku = async () => (await store.get('users')) || [];
  const urunleriOku = async () => (await store.get('products')) || [];
  const isleriOku = async () => (await store.get('jobs')) || [];
  async function ayarOku() {
    const k = (await store.get('settings')) || {};
    return {
      ...VARSAYILAN_AYAR, ...k,
      kom: { ...VARSAYILAN_AYAR.kom, ...(k.kom || {}) },
      bag: { ...(k.bag || {}) }
    };
  }
  async function adHaritasi() {
    return new Map((await kullanicilariOku()).map((u) => [u.id, u.name]));
  }
  async function govde(req) {
    try { return (await req.json()) || {}; } catch { return {}; }
  }
  async function hareketYaz(user, urun, eski, yeni, tur, neden) {
    const t = new Date().toISOString();
    const anahtar = 'moves:' + t.slice(0, 7);
    const ay = (await store.get(anahtar)) || [];
    ay.push({
      id: uid(), t, user: { id: user.id, name: user.name },
      barkod: urun.barkod, ad: urun.ad, eski, yeni, fark: yeni - eski, tur, neden
    });
    await store.set(anahtar, ay);
  }

  const finans = finansKur({ store, json, hata, sayi, r2, uid, govde, hareketYaz });
  const siparis = siparisKur({ store, json, hata, sayi, r2, uid, govde, hareketYaz, ayarOku });

  async function handler(req) {
    try { return await yonlendir(req); }
    catch (e) { console.error(e); return hata(500, 'Sunucu hatası'); }
  }
  handler.yedekAl = finans.yedekAl;
  return handler;

  async function yonlendir(req) {
    const url = new URL(req.url);
    const parcalar = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
    const yontem = req.method;
    const [a, b, c, d] = parcalar;

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
      if (b && c === 'sayim' && yontem === 'POST') return stokSayim(req, b, user);
      if (!yonetici) return yetkiYok();
      if (!b && yontem === 'POST') return urunEkle(req);
      if (b === 'import' && yontem === 'POST') return icAktar(req);
      if (b && !c && yontem === 'PUT') return urunGuncelle(req, b, user);
      if (b && !c && yontem === 'DELETE') return urunSil(b);
    }
    if (a === 'stock-moves' && !b && yontem === 'GET') return hareketListele(url, user);
    if (a === 'sales') {
      if (!b && yontem === 'GET') return satisListele(url, user);
      if (!b && yontem === 'POST') return satisYap(req, user);
    }
    if (a === 'jobs') {
      if (!b && yontem === 'GET') return isListele(url, user);
      if (!b && yontem === 'POST') return yonetici ? isEkle(req, user) : yetkiYok();
      if (b && !c) {
        if (yontem === 'GET') return isIsle(b, user, async (j) => isYanit(j, user));
        if (yontem === 'PUT') return yonetici ? isGuncelle(req, b, user) : yetkiYok();
        if (yontem === 'DELETE') return yonetici ? isSil(b) : yetkiYok();
      }
      if (b && c === 'durum' && yontem === 'POST') return isDurum(req, b, user);
      if (b && c === 'notes' && yontem === 'POST') return isNot(req, b, user);
      if (b && c === 'parts' && !d && yontem === 'POST') return isParcaEkle(req, b, user);
      if (b && c === 'parts' && d && yontem === 'DELETE') return isParcaSil(b, d, user);
      if (b && c === 'costs' && !d && yontem === 'POST') return isMasrafEkle(req, b, user);
      if (b && c === 'costs' && d && yontem === 'DELETE') return isMasrafSil(b, d, user);
    }
    if (['cariler', 'hesaplar', 'odemeler', 'belgeler', 'fiyat-listeleri', 'backup'].includes(a)) {
      if (!yonetici) return yetkiYok();
      const r = await finans.yonlendir(a, b, c, d, yontem, req, url, user);
      if (r) return r;
    }
    if (a === 'orders') {
      if (!yonetici) return yetkiYok();
      return siparis.yonlendir(b, c, yontem, req, url, user);
    }
    if (a === 'accounting') {
      if (!yonetici) return yetkiYok();
      if (b === 'dashboard' && yontem === 'GET') return panoOzeti();
      if (b === 'expenses' && !c && yontem === 'GET') return giderListele(url);
      if (b === 'expenses' && !c && yontem === 'POST') return giderEkle(req, user);
      if (b === 'expenses' && c && yontem === 'DELETE') return giderSil(url, c);
      if (b === 'summary' && yontem === 'GET') return muhasebeOzet(url);
      if (b === 'year' && yontem === 'GET') return muhasebeYil(url);
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
    const panel = b.panel === 'admin' ? 'admin' : b.panel === 'staff' ? 'staff' : null;
    if (!panel) return hata(400, 'Giriş paneli belirtilmeli');
    const kadi = String(b.username || '').trim().toLowerCase();
    const sifre = String(b.password || '');
    let kullanicilar = await kullanicilariOku();

    // İlk kurulum: kullanıcı yoksa ortam değişkenindeki yönetici bilgisiyle ilk hesap açılır.
    if (panel === 'admin' && !kullanicilar.length && ortam.ADMIN_PASSWORD) {
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
    if ((panel === 'admin') !== (u.role === 'admin')) {
      return hata(403, panel === 'admin'
        ? 'Bu hesap personel hesabıdır. Personel girişini kullanın.'
        : 'Bu hesap yönetici hesabıdır. Yönetici girişini (/admin) kullanın.');
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

  function aktifYoneticiSayisi(l) { return l.filter((x) => x.role === 'admin' && x.active).length; }

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

  async function urunGuncelle(req, barkod, user) {
    const ayar = await ayarOku();
    const urunler = await urunleriOku();
    const m = urunler.find((u) => u.barkod === barkod);
    if (!m) return hata(404, 'Ürün bulunamadı');
    const b = await govde(req);
    const degisen = Object.fromEntries(Object.entries(b).filter(([, v]) => v !== null && v !== undefined));
    const t = urunTemizle({ ...m, ...degisen, barkod }, ayar);
    if (t.hata) return hata(400, t.hata);
    const eskiStok = m.stok;
    Object.assign(m, t.urun, { stok: t.urun.stok ?? m.stok, min: t.urun.min ?? m.min });
    await store.set('products', urunler);
    if (m.stok !== eskiStok) await hareketYaz(user, m, eskiStok, m.stok, 'duzeltme', 'Yönetici düzenlemesi');
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

  /* ---------- stok sayımı ve hareketler ---------- */
  async function stokSayim(req, barkod, user) {
    const b = await govde(req);
    const ham = sayi(b.yeni, -1, 1e7);
    if (Number.isNaN(ham) || ham < 0) return hata(400, 'Sayım adedi geçersiz');
    const yeni = Math.round(ham);
    const neden = String(b.neden || '').trim().slice(0, 120);
    if (neden.length < 3) return hata(400, 'Değişiklik nedenini yazın');
    const urunler = await urunleriOku();
    const u = urunler.find((x) => x.barkod === barkod);
    if (!u) return hata(404, 'Ürün bulunamadı');
    if (u.stok === yeni) return hata(400, 'Stok zaten bu değerde');
    const eski = u.stok;
    u.stok = yeni;
    await store.set('products', urunler);
    await hareketYaz(user, u, eski, yeni, 'sayim', neden);
    return json(urunGorunum(u, user.role === 'admin'));
  }

  /* ---------- muhasebe ---------- */
  function ayGecerli(s) { return /^\d{4}-(0[1-9]|1[0-2])$/.test(s || ''); }
  function istAy(iso) { return new Date(Date.parse(iso) + 3 * 36e5).toISOString().slice(0, 7); }
  function ayKaydir(ay, d) {
    const [y, m] = ay.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1 + d, 1)).toISOString().slice(0, 7);
  }
  async function giderleriOku(ay) { return (await store.get('expenses:' + ay)) || []; }
  async function giderListele(url) {
    const ay = url.searchParams.get('ay');
    if (!ayGecerli(ay)) return hata(400, 'Ay geçersiz');
    const l = await giderleriOku(ay);
    l.sort((p, q) => (p.tarih < q.tarih ? 1 : p.tarih > q.tarih ? -1 : (p.t < q.t ? 1 : -1)));
    return json(l);
  }
  async function giderEkle(req, user) {
    let b; try { b = await req.json(); } catch { return hata(400, 'Geçersiz istek'); }
    const tarih = String(b.tarih || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(tarih) || Number.isNaN(Date.parse(tarih)) || new Date(tarih).toISOString().slice(0, 10) !== tarih) return hata(400, 'Tarih geçersiz');
    if (!GIDER_TURLERI.includes(b.tur)) return hata(400, 'Gider türü geçersiz');
    const tutar = sayi(b.tutar, 0, 1e9);
    if (Number.isNaN(tutar) || tutar <= 0) return hata(400, 'Tutar sıfırdan büyük olmalı');
    const aciklama = String(b.aciklama || '').trim().slice(0, 200);
    const kisi = String(b.kisi || '').trim().slice(0, 80);
    const g = { id: uid(), t: new Date().toISOString(), tarih, tur: b.tur, aciklama, kisi, tutar: r2(tutar), user: { id: user.id, name: user.name } };
    if (b.hesap) {
      const h = ((await store.get('hesaplar')) || []).find((x) => x.id === b.hesap && x.aktif);
      if (!h) return hata(400, 'Kasa/banka hesabı bulunamadı');
      g.hesap = h.id;
      await finans.defterEkle(h.id, -g.tutar, 'gider', g.id, `Gider: ${GIDER_AD[g.tur] || g.tur}${aciklama ? ' · ' + aciklama : ''}`, tarih, user);
    }
    const ay = tarih.slice(0, 7);
    const l = await giderleriOku(ay); l.push(g);
    await store.set('expenses:' + ay, l);
    return json(g, 201);
  }
  async function giderSil(url, id) {
    const ay = url.searchParams.get('ay');
    if (!ayGecerli(ay)) return hata(400, 'Ay geçersiz');
    const l = await giderleriOku(ay);
    if (!l.some((g) => g.id === id)) return hata(404, 'Gider bulunamadı');
    await store.set('expenses:' + ay, l.filter((g) => g.id !== id));
    await finans.defterRefSil(id);
    return json({ ok: true });
  }
  async function muhasebeVeri(aylar) {
    const ilk = ayKaydir(aylar[0], -1), son = ayKaydir(aylar[aylar.length - 1], 1);
    const satisAnahtar = []; for (let a = ilk; a <= son; a = ayKaydir(a, 1)) satisAnahtar.push('sales:' + a);
    const [satisAylari, isler, giderAylari, ayar, belgeler] = await Promise.all([
      Promise.all(satisAnahtar.map((k) => store.get(k))), isleriOku(),
      Promise.all(aylar.map(giderleriOku)), ayarOku(), finans.belgeleriOku()
    ]);
    const giderler = {}; aylar.forEach((a, i) => { giderler[a] = giderAylari[i]; });
    return { satislar: satisAylari.flat().filter(Boolean), isler, giderler, ayar, belgeler };
  }
  function ayHesapla(ay, v) {
    const sat = v.satislar.filter((s) => istAy(s.t) === ay);
    const biten = v.isler.filter((j) => j.durum === 'tamam' && j.bitis && istAy(j.bitis) === ay);
    const gid = v.giderler[ay] || [];
    const r = v.ayar.kdvAcik ? v.ayar.kdv / 100 : 0;
    const fat = v.belgeler.filter((x) => x.tur === 'satis' && x.durum === 'acik' && x.tarih.slice(0, 7) === ay);
    const faturaGelir = r2(fat.reduce((a, x) => a + x.ara - x.iskontoTutar, 0));
    const faturaMaliyet = r2(fat.reduce((a, x) => a + x.satirlar.reduce((m, l) => m + (l.alis || 0) * l.adet, 0), 0));
    const satisCiro = r2(sat.reduce((a, s) => a + s.ciro, 0));
    const isGelir = r2(biten.reduce((a, j) => a + (j.ucret || 0), 0));
    const urun = r2(sat.reduce((a, s) => a + s.maliyet, 0) + faturaMaliyet);
    const komisyon = r2(sat.reduce((a, s) => a + (s.kom || 0) + (s.ek || 0), 0));
    const kdv = r2(sat.reduce((a, s) => a + (r ? (s.ciro - s.maliyet) * r / (1 + r) : 0), 0));
    const oz = biten.map(isOzet);
    const isParca = r2(oz.reduce((a, o) => a + o.parca, 0));
    const isMasraf = r2(oz.reduce((a, o) => a + o.masraf, 0));
    const genel = {}; let genelToplam = 0; let stokAlim = 0; const maasKisi = {};
    gid.forEach((g) => {
      if (g.tur === 'stok_alim') { stokAlim += g.tutar; return; }
      genel[g.tur] = r2((genel[g.tur] || 0) + g.tutar); genelToplam += g.tutar;
      if (g.tur === 'maas') { const k = g.kisi || 'Belirtilmemiş'; maasKisi[k] = r2((maasKisi[k] || 0) + g.tutar); }
    });
    genelToplam = r2(genelToplam);
    const gelir = r2(satisCiro + isGelir + faturaGelir);
    const giderToplam = r2(urun + komisyon + kdv + isParca + isMasraf + genelToplam);
    const net = r2(gelir - giderToplam);
    return {
      ay, gelir: { satis: satisCiro, fatura: faturaGelir, is: isGelir, toplam: gelir },
      gider: { urun, komisyon, kdv, isParca, isMasraf, genel, genelToplam, toplam: giderToplam },
      net, marj: gelir ? r2(net / gelir * 100) : 0, stokAlim: r2(stokAlim), maasKisi,
      adet: { satis: sat.length, fatura: fat.length, is: biten.length }
    };
  }
  async function muhasebeOzet(url) {
    const ay = url.searchParams.get('ay');
    if (!ayGecerli(ay)) return hata(400, 'Ay geçersiz');
    return json(ayHesapla(ay, await muhasebeVeri([ay])));
  }
  function istGun(iso) { return new Date(Date.parse(iso) + 3 * 36e5).toISOString().slice(0, 10); }
  async function panoOzeti() {
    const bu = istGun(new Date().toISOString()); const ay = bu.slice(0, 7);
    const [v, urunler, vade, sip] = await Promise.all([muhasebeVeri([ay]), urunleriOku(), finans.vadeOzeti(), siparis.ozet()]);
    const h = ayHesapla(ay, v);
    const bugunSatis = v.satislar.filter((x) => istGun(x.t) === bu);
    const bugunFatura = v.belgeler.filter((x) => x.tur === 'satis' && x.durum === 'acik' && x.tarih === bu);
    const bugunIs = v.isler.filter((j) => j.durum === 'tamam' && j.bitis && istGun(j.bitis) === bu);
    const bs = r2(bugunSatis.reduce((a, x) => a + x.ciro, 0));
    const bf = r2(bugunFatura.reduce((a, x) => a + x.ara - x.iskontoTutar, 0));
    const bi = r2(bugunIs.reduce((a, j) => a + (j.ucret || 0), 0));
    const aySatis = v.satislar.filter((x) => istAy(x.t) === ay);
    const eticaret = aySatis.filter((x) => x.kanal !== 'magaza');
    const acik = v.isler.filter((j) => j.durum === 'bekliyor' || j.durum === 'devam');
    return json({
      tarih: bu,
      bugun: { ciro: r2(bs + bf + bi), satis: bs, fatura: bf, is: bi, adet: bugunSatis.length + bugunFatura.length + bugunIs.length },
      ay: { net: h.net, marj: h.marj, gelir: h.gelir.toplam, gider: h.gider.toplam, servis: h.gelir.is, servisAdet: h.adet.is,
        eticaret: r2(eticaret.reduce((a, x) => a + x.ciro, 0)), eticaretAdet: eticaret.length,
        eticaretNet: r2(eticaret.reduce((a, x) => a + x.ciro - x.maliyet - x.kom - x.ek, 0)) },
      uyari: {
        bekleyenIs: v.isler.filter((j) => j.durum === 'bekliyor').length,
        devamIs: v.isler.filter((j) => j.durum === 'devam').length,
        acilIs: acik.filter((j) => j.oncelik === 'acil').length,
        gecikenIs: acik.filter((j) => j.termin && j.termin < bu).length,
        bekleyenSiparis: sip.bekleyen, bekleyenSiparisTutar: sip.bekleyenTutar, kargodaSiparis: sip.kargoda,
        kritikStok: urunler.filter((u) => u.stok <= u.min).length, tukenen: urunler.filter((u) => u.stok <= 0).length,
        gecikenTahsilat: vade.gecikenTahsilat, gecikenOdeme: vade.gecikenOdeme, toplamAlacak: vade.toplamAlacak, toplamBorc: vade.toplamBorc
      }
    });
  }

  async function muhasebeYil(url) {
    const yil = parseInt(url.searchParams.get('yil') || '', 10);
    if (!(yil >= 2000 && yil <= 2100)) return hata(400, 'Yıl geçersiz');
    const aylar = Array.from({ length: 12 }, (_, i) => `${yil}-${String(i + 1).padStart(2, '0')}`);
    const v = await muhasebeVeri(aylar);
    return json(aylar.map((a) => ayHesapla(a, v)));
  }

  async function hareketListele(url, user) {
    const yonetici = user.role === 'admin';
    const simdi = new Date();
    const anahtarlar = [0, 1, 2].map((i) => 'moves:' + new Date(Date.UTC(simdi.getUTCFullYear(), simdi.getUTCMonth() - i, 1)).toISOString().slice(0, 7));
    let liste = (await Promise.all(anahtarlar.map((k) => store.get(k)))).flat().filter(Boolean);
    if (!yonetici) liste = liste.filter((m) => m.user && m.user.id === user.id);
    const barkod = url.searchParams.get('barkod');
    if (barkod) liste = liste.filter((m) => m.barkod === barkod);
    liste.sort((p, q) => (p.t < q.t ? 1 : -1));
    const ust = yonetici ? 200 : 50;
    const limit = Math.min(ust, Math.max(1, parseInt(url.searchParams.get('limit') || String(ust), 10) || ust));
    return json(liste.slice(0, limit));
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
    const ayarlar = await ayarOku();
    if (ayarlar.satisHesap) {
      const h = ((await store.get('hesaplar')) || []).find((x) => x.id === ayarlar.satisHesap && x.aktif);
      if (h) await finans.defterEkle(h.id, satis.ciro, 'satis', satis.id, `Barkodlu satış (${satis.mod})`, undefined, user);
    }
    return json({ satis: satisGorunum(satis, yonetici), urunler: etkilenen.map((u) => urunGorunum(u, yonetici)) }, 201);
  }

  async function satisListele(url, user) {
    const yonetici = user.role === 'admin';
    const simdi = new Date();
    const bit = new Date(url.searchParams.get('to') || simdi.getTime() + 864e5);
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

  /* ---------- işler (iş dağılımı) ---------- */
  async function isIsle(id, user, fn) {
    const jobs = await isleriOku();
    const j = jobs.find((x) => x.id === id);
    if (!j || (user.role !== 'admin' && j.atanan !== user.id)) return hata(404, 'İş bulunamadı');
    return fn(j, jobs);
  }
  async function isYanit(j, user, status = 200) {
    return json(isGorunum(j, user.role === 'admin', await adHaritasi()), status);
  }
  async function personelBul(id) {
    return (await kullanicilariOku()).find((x) => x.id === id && x.active && x.role === 'staff');
  }

  async function isListele(url, user) {
    const yonetici = user.role === 'admin';
    let jobs = await isleriOku();
    if (!yonetici) jobs = jobs.filter((j) => j.atanan === user.id);
    const durum = url.searchParams.get('durum');
    if (durum && DURUMLAR.includes(durum)) jobs = jobs.filter((j) => j.durum === durum);
    const atanan = url.searchParams.get('atanan');
    if (yonetici && atanan) jobs = jobs.filter((j) => j.atanan === atanan);
    jobs = [...jobs].sort((p, q) => q.no - p.no).slice(0, 1000);
    const adlar = await adHaritasi();
    return json(jobs.map((j) => isGorunum(j, yonetici, adlar)));
  }

  async function isEkle(req, user) {
    const b = await govde(req);
    const t = isTemizle(b);
    if (t.hata) return hata(400, t.hata);
    let atanan = null;
    if (b.atanan) {
      if (!(await personelBul(b.atanan))) return hata(400, 'Atanacak personel bulunamadı');
      atanan = b.atanan;
    }
    const jobs = await isleriOku();
    const no = jobs.reduce((m, j) => Math.max(m, j.no), 0) + 1;
    const j = {
      id: uid(), no, ...t.is, durum: 'bekliyor', atanan,
      olusturan: { id: user.id, name: user.name }, olusturma: new Date().toISOString(),
      baslama: '', bitis: '', notlar: [], parcalar: [], masraflar: []
    };
    jobs.push(j);
    await store.set('jobs', jobs);
    return isYanit(j, user, 201);
  }

  async function isGuncelle(req, id, user) {
    const b = await govde(req);
    return isIsle(id, user, async (j, jobs) => {
      const degisen = Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined && v !== null));
      const t = isTemizle({ ...j, ...degisen });
      if (t.hata) return hata(400, t.hata);
      if (b.atanan !== undefined) {
        if (b.atanan) {
          if (!(await personelBul(b.atanan))) return hata(400, 'Atanacak personel bulunamadı');
          j.atanan = b.atanan;
        } else j.atanan = null;
      }
      Object.assign(j, t.is);
      if (b.durum !== undefined) {
        if (!DURUMLAR.includes(b.durum)) return hata(400, 'Durum geçersiz');
        durumUygula(j, b.durum);
      }
      await store.set('jobs', jobs);
      return isYanit(j, user);
    });
  }

  function durumUygula(j, yeni) {
    const simdi = new Date().toISOString();
    j.durum = yeni;
    if (yeni === 'devam') { j.baslama = j.baslama || simdi; j.bitis = ''; }
    else if (yeni === 'tamam') { j.baslama = j.baslama || simdi; j.bitis = simdi; }
    else if (yeni === 'bekliyor') { j.bitis = ''; }
  }

  async function isSil(id) {
    const jobs = await isleriOku();
    if (!jobs.some((j) => j.id === id)) return hata(404, 'İş bulunamadı');
    await store.set('jobs', jobs.filter((j) => j.id !== id));
    return json({ tamam: true });
  }

  async function isDurum(req, id, user) {
    const yonetici = user.role === 'admin';
    const b = await govde(req);
    const yeni = String(b.durum || '');
    if (!DURUMLAR.includes(yeni)) return hata(400, 'Durum geçersiz');
    return isIsle(id, user, async (j, jobs) => {
      if (!yonetici) {
        if (j.durum === 'iptal') return hata(403, 'İptal edilmiş işin durumu değiştirilemez');
        if (!['devam', 'tamam'].includes(yeni)) return hata(403, 'Bu duruma geçemezsiniz');
      }
      durumUygula(j, yeni);
      await store.set('jobs', jobs);
      return isYanit(j, user);
    });
  }

  // Personel, tamamlanan veya iptal edilen işte değişiklik yapamaz.
  function personelKilitli(j, user) { return user.role !== 'admin' && (j.durum === 'tamam' || j.durum === 'iptal'); }

  async function isNot(req, id, user) {
    const b = await govde(req);
    const metin = String(b.metin || '').trim().slice(0, 500);
    if (!metin) return hata(400, 'Not boş olamaz');
    return isIsle(id, user, async (j, jobs) => {
      if (j.notlar.length >= 200) return hata(409, 'Bu işte çok fazla not var');
      j.notlar.push({ id: uid(), t: new Date().toISOString(), user: { id: user.id, name: user.name }, metin });
      await store.set('jobs', jobs);
      return isYanit(j, user, 201);
    });
  }

  async function isParcaEkle(req, id, user) {
    const b = await govde(req);
    const barkod = String(b.barkod || '').trim();
    const adet = Math.round(sayi(b.adet, 0, 1e6));
    if (!barkod || !(adet >= 1)) return hata(400, 'Barkod ve adet gerekli');
    return isIsle(id, user, async (j, jobs) => {
      if (personelKilitli(j, user)) return hata(403, 'Tamamlanan işe parça eklenemez. Yeniden açın.');
      const urunler = await urunleriOku();
      const u = urunler.find((x) => x.barkod === barkod);
      if (!u) return hata(404, `Barkod bulunamadı: ${barkod}`);
      if (u.stok < adet) return hata(409, `${u.ad}: stokta yalnızca ${u.stok} adet var`);
      const eski = u.stok;
      u.stok -= adet;
      j.parcalar.push({
        id: uid(), t: new Date().toISOString(), user: { id: user.id, name: user.name },
        barkod: u.barkod, ad: u.ad, adet, alis: u.alis
      });
      await store.set('products', urunler);
      await store.set('jobs', jobs);
      await hareketYaz(user, u, eski, u.stok, 'is', `İş #${j.no}: parça kullanıldı`);
      return isYanit(j, user, 201);
    });
  }

  async function isParcaSil(id, parcaId, user) {
    return isIsle(id, user, async (j, jobs) => {
      const p = j.parcalar.find((x) => x.id === parcaId);
      if (!p) return hata(404, 'Parça kaydı bulunamadı');
      if (user.role !== 'admin') {
        if (personelKilitli(j, user)) return hata(403, 'Tamamlanan işte parça silinemez');
        if (p.user.id !== user.id) return hata(403, 'Yalnızca kendi eklediğiniz parçayı kaldırabilirsiniz');
      }
      const urunler = await urunleriOku();
      const u = urunler.find((x) => x.barkod === p.barkod);
      if (u) {
        const eski = u.stok;
        u.stok += p.adet;
        await store.set('products', urunler);
        await hareketYaz(user, u, eski, u.stok, 'is', `İş #${j.no}: parça iade edildi`);
      }
      j.parcalar = j.parcalar.filter((x) => x.id !== parcaId);
      await store.set('jobs', jobs);
      return isYanit(j, user);
    });
  }

  async function isMasrafEkle(req, id, user) {
    const b = await govde(req);
    const aciklama = String(b.aciklama || '').trim().slice(0, 120);
    const tutar = sayi(b.tutar, 0, 1e7);
    if (!aciklama) return hata(400, 'Masraf açıklaması gerekli');
    if (!(tutar > 0)) return hata(400, 'Tutar sıfırdan büyük olmalı');
    const tur = MASRAF_TURLERI.includes(b.tur) ? b.tur : 'diger';
    return isIsle(id, user, async (j, jobs) => {
      if (personelKilitli(j, user)) return hata(403, 'Tamamlanan işe masraf eklenemez. Yeniden açın.');
      if (j.masraflar.length >= 200) return hata(409, 'Bu işte çok fazla masraf kaydı var');
      j.masraflar.push({ id: uid(), t: new Date().toISOString(), user: { id: user.id, name: user.name }, aciklama, tutar: r2(tutar), tur });
      await store.set('jobs', jobs);
      return isYanit(j, user, 201);
    });
  }

  async function isMasrafSil(id, masrafId, user) {
    return isIsle(id, user, async (j, jobs) => {
      const m = j.masraflar.find((x) => x.id === masrafId);
      if (!m) return hata(404, 'Masraf kaydı bulunamadı');
      if (user.role !== 'admin') {
        if (personelKilitli(j, user)) return hata(403, 'Tamamlanan işte masraf silinemez');
        if (m.user.id !== user.id) return hata(403, 'Yalnızca kendi eklediğiniz masrafı silebilirsiniz');
      }
      j.masraflar = j.masraflar.filter((x) => x.id !== masrafId);
      await store.set('jobs', jobs);
      return isYanit(j, user);
    });
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
    if (b.satisHesap !== undefined) n.satisHesap = b.satisHesap ? String(b.satisHesap) : null;
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
