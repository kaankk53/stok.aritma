// Siparişler: pazaryeri / web siparişlerinin elle takibi.
// Sipariş "kargoda" veya "teslim" olunca stoktan düşer ve satış (ciro) olarak kaydedilir.
// Sonra iptal edilirse stok geri gelir ve satış kaydı silinir.

const YIL_BASLANGIC = 2024;
const DURUMLAR = ['bekliyor', 'hazirlaniyor', 'kargoda', 'teslim', 'iptal'];
const KANALLAR = ['trendyol', 'hepsiburada', 'n11', 'amazon', 'ciceksepeti', 'web'];
const SATIS_VAR = ['kargoda', 'teslim'];

export function siparisKur(c) {
  const { store, json, hata, sayi, r2, uid, govde, hareketYaz, ayarOku } = c;
  const metin = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
  const yillar = () => { const l = []; for (let y = YIL_BASLANGIC; y <= new Date().getUTCFullYear() + 1; y++) l.push(y); return l; };
  const bugun = () => new Date(Date.now() + 3 * 36e5).toISOString().slice(0, 10);

  async function hepsiniOku() {
    return (await Promise.all(yillar().map((y) => store.get('orders:' + y)))).flat().filter(Boolean);
  }
  async function kaydet(siparis) {
    const k = 'orders:' + siparis.tarih.slice(0, 4);
    const l = (await store.get(k)) || [];
    const i = l.findIndex((x) => x.id === siparis.id);
    if (i >= 0) l[i] = siparis; else l.push(siparis);
    await store.set(k, l);
  }
  async function sil(siparis) {
    const k = 'orders:' + siparis.tarih.slice(0, 4);
    await store.set(k, ((await store.get(k)) || []).filter((x) => x.id !== siparis.id));
  }
  async function numaraAl(yil) {
    const s = (await store.get('sayac')) || {};
    const k = 'siparis:' + yil; s[k] = (s[k] || 0) + 1;
    await store.set('sayac', s);
    return `SP-${yil}-${String(s[k]).padStart(4, '0')}`;
  }

  /* ---------- satış kaydı oluştur / geri al ---------- */
  async function satisOlustur(siparis, user) {
    const urunler = (await store.get('products')) || [];
    const gerekli = new Map();
    siparis.satirlar.forEach((s) => gerekli.set(s.barkod, (gerekli.get(s.barkod) || 0) + s.adet));
    for (const [bk, adet] of gerekli) {
      const u = urunler.find((x) => x.barkod === bk);
      if (!u) return { hata: `Ürün bulunamadı: ${bk}` };
      if (u.stok < adet) return { hata: `Yetersiz stok: ${u.ad} (stok ${u.stok}, gereken ${adet})` };
    }
    const satirlar = [];
    for (const s of siparis.satirlar) {
      const u = urunler.find((x) => x.barkod === s.barkod);
      const eski = u.stok; u.stok -= s.adet;
      await hareketYaz(user, u, eski, u.stok, 'siparis', `Sipariş ${siparis.no}`);
      satirlar.push({ barkod: u.barkod, ad: u.ad, adet: s.adet, fiyat: s.fiyat, alis: u.alis });
    }
    await store.set('products', urunler);
    const ayar = await ayarOku();
    const ciro = r2(satirlar.reduce((a, s) => a + s.fiyat * s.adet, 0));
    const t = new Date().toISOString();
    const satis = {
      id: uid(), t, mod: 'perakende', kanal: siparis.kanal, musteri: siparis.musteri, user: { id: user.id, name: user.name },
      satirlar, ciro, maliyet: r2(satirlar.reduce((a, s) => a + s.alis * s.adet, 0)),
      kom: r2(ciro * ((ayar.kom && ayar.kom[siparis.kanal]) || 0) / 100), ek: r2((ayar.kargo || 0) + (ayar.paket || 0)), siparis: siparis.id
    };
    const ay = 'sales:' + t.slice(0, 7);
    const l = (await store.get(ay)) || []; l.push(satis); await store.set(ay, l);
    return { satis, ay };
  }
  async function satisGeriAl(siparis, user) {
    const urunler = (await store.get('products')) || [];
    for (const s of siparis.satirlar) {
      const u = urunler.find((x) => x.barkod === s.barkod);
      if (!u) continue;
      const eski = u.stok; u.stok += s.adet;
      await hareketYaz(user, u, eski, u.stok, 'siparis', `Sipariş ${siparis.no}: geri alındı`);
    }
    await store.set('products', urunler);
    if (siparis.saleAy) {
      const l = (await store.get(siparis.saleAy)) || [];
      await store.set(siparis.saleAy, l.filter((x) => x.id !== siparis.saleId));
    }
  }

  /* ---------- rotalar ---------- */
  async function yonlendir(b, c2, yontem, req, url, user) {
    if (!b && yontem === 'GET') {
      let l = await hepsiniOku();
      const d = url.searchParams.get('durum'); const k = url.searchParams.get('kanal');
      if (d === 'acik') l = l.filter((x) => x.durum === 'bekliyor' || x.durum === 'hazirlaniyor');
      else if (d) l = l.filter((x) => x.durum === d);
      if (k) l = l.filter((x) => x.kanal === k);
      l.sort((p, q) => (p.t < q.t ? 1 : -1));
      return json(l.slice(0, 500));
    }
    if (!b && yontem === 'POST') {
      const o = await govde(req);
      const kanal = KANALLAR.includes(o.kanal) ? o.kanal : null;
      if (!kanal) return hata(400, 'Pazaryeri seçin');
      if (!Array.isArray(o.satirlar) || !o.satirlar.length || o.satirlar.length > 100) return hata(400, 'En az bir ürün ekleyin');
      const urunler = (await store.get('products')) || [];
      const satirlar = [];
      for (const s of o.satirlar) {
        const u = urunler.find((x) => x.barkod === String(s.barkod || ''));
        const adet = Math.round(sayi(s.adet, 0, 1e6)); const fiyat = sayi(s.fiyat, 0, 1e9);
        if (!u) return hata(400, `Ürün bulunamadı: ${s.barkod || ''}`);
        if (!(adet >= 1)) return hata(400, 'Adet en az 1 olmalı');
        if (Number.isNaN(fiyat)) return hata(400, 'Fiyat geçersiz');
        satirlar.push({ barkod: u.barkod, ad: u.ad, adet, fiyat: r2(fiyat) });
      }
      const tarih = o.tarih || bugun();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(tarih) || Number.isNaN(Date.parse(tarih))) return hata(400, 'Tarih geçersiz');
      const siparis = {
        id: uid(), no: await numaraAl(tarih.slice(0, 4)), t: new Date().toISOString(), tarih, kanal, harici: metin(o.harici, 60),
        musteri: metin(o.musteri, 100), telefon: metin(o.telefon, 40), adres: metin(o.adres, 300), satirlar,
        tutar: r2(satirlar.reduce((a, s) => a + s.adet * s.fiyat, 0)), durum: 'bekliyor', notlar: metin(o.notlar, 500),
        user: { id: user.id, name: user.name }, gecmis: [{ t: new Date().toISOString(), durum: 'bekliyor', user: user.name }]
      };
      await kaydet(siparis);
      return json(siparis, 201);
    }
    if (b && !c2 && yontem === 'GET') {
      const s = (await hepsiniOku()).find((x) => x.id === b);
      return s ? json(s) : hata(404, 'Sipariş bulunamadı');
    }
    if (b && c2 === 'durum' && yontem === 'POST') {
      const o = await govde(req);
      if (!DURUMLAR.includes(o.durum)) return hata(400, 'Durum geçersiz');
      const s = (await hepsiniOku()).find((x) => x.id === b);
      if (!s) return hata(404, 'Sipariş bulunamadı');
      if (s.durum === o.durum) return json(s);
      const eskiVar = Boolean(s.saleId); const yeniVar = SATIS_VAR.includes(o.durum);
      if (yeniVar && !eskiVar) {
        const r = await satisOlustur(s, user);
        if (r.hata) return hata(409, r.hata);
        s.saleId = r.satis.id; s.saleAy = r.ay;
      } else if (!yeniVar && eskiVar) {
        await satisGeriAl(s, user);
        delete s.saleId; delete s.saleAy;
      }
      s.durum = o.durum;
      s.gecmis = [...(s.gecmis || []), { t: new Date().toISOString(), durum: o.durum, user: user.name }];
      await kaydet(s);
      return json(s);
    }
    if (b && !c2 && yontem === 'DELETE') {
      const s = (await hepsiniOku()).find((x) => x.id === b);
      if (!s) return hata(404, 'Sipariş bulunamadı');
      if (s.saleId) return hata(400, 'Satışa işlenmiş sipariş silinemez. Önce iptal edin.');
      await sil(s);
      return json({ ok: true });
    }
    return hata(404, 'Bulunamadı');
  }

  async function ozet() {
    const l = await hepsiniOku();
    const bek = l.filter((x) => x.durum === 'bekliyor' || x.durum === 'hazirlaniyor');
    return { bekleyen: bek.length, bekleyenTutar: r2(bek.reduce((a, x) => a + x.tutar, 0)), kargoda: l.filter((x) => x.durum === 'kargoda').length };
  }

  return { yonlendir, ozet };
}
