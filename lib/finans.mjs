// Finans modülü: cari hesaplar, kasa/banka, tahsilat-ödeme, fatura/irsaliye, fiyat listeleri, yedek.
// Yalnızca yönetici erişir. handler.mjs içinden çağrılır; depolama dışarıdan verilir.

const YIL_BASLANGIC = 2024;
const CARI_TURLERI = ['musteri', 'tedarikci', 'ikisi'];
const HESAP_TURLERI = ['kasa', 'banka'];
const BELGE_TURLERI = { satis: 'SF', alis: 'AF', irsaliye: 'IR' };
const FIYAT_KAYNAKLARI = ['perakende', 'toptan', 'alis'];
const YEDEK_SAKLA = 14;

export function finansKur(c) {
  const { store, json, hata, sayi, r2, uid, govde, hareketYaz } = c;

  const yillar = () => {
    const son = new Date().getUTCFullYear() + 1;
    const l = [];
    for (let y = YIL_BASLANGIC; y <= son; y++) l.push(y);
    return l;
  };
  const tarihGecerli = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;
  const bugun = () => new Date(Date.now() + 3 * 36e5).toISOString().slice(0, 10);
  const metin = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

  /* ---------- depolama yardımcıları ---------- */
  async function listeOku(anahtar) { return (await store.get(anahtar)) || []; }
  async function yillikOku(onek) {
    const l = await Promise.all(yillar().map((y) => store.get(`${onek}:${y}`)));
    return l.flat().filter(Boolean);
  }
  async function yillikEkle(onek, tarih, kayit) {
    const k = `${onek}:${tarih.slice(0, 4)}`;
    const l = await listeOku(k); l.push(kayit); await store.set(k, l);
  }
  async function yillikGuncelle(onek, id, fn) {
    for (const y of yillar()) {
      const k = `${onek}:${y}`;
      const l = await store.get(k);
      if (l && l.some((x) => x.id === id)) {
        const yeni = fn(l);
        await store.set(k, yeni);
        return true;
      }
    }
    return false;
  }
  async function sayacAl(tur, yil) {
    const s = (await store.get('sayac')) || {};
    const k = `${tur}:${yil}`;
    s[k] = (s[k] || 0) + 1;
    await store.set('sayac', s);
    return s[k];
  }

  /* ---------- hesap defteri (para hareketleri) ---------- */
  async function defterEkle(hesap, tutar, tur, ref, aciklama, tarih, user) {
    const e = {
      id: uid(), t: new Date().toISOString(), tarih: tarih || bugun(), hesap, tutar: r2(tutar), tur, ref: ref || null,
      aciklama: metin(aciklama, 200), user: user ? { id: user.id, name: user.name } : null
    };
    await yillikEkle('defter', e.tarih, e);
    return e;
  }
  async function defterRefSil(ref) {
    let silindi = 0;
    for (const y of yillar()) {
      const k = `defter:${y}`;
      const l = await store.get(k);
      if (l && l.some((e) => e.ref === ref)) {
        silindi += l.filter((e) => e.ref === ref).length;
        await store.set(k, l.filter((e) => e.ref !== ref));
      }
    }
    return silindi;
  }
  async function hesapBakiyeleri() {
    const [hesaplar, defter] = await Promise.all([listeOku('hesaplar'), yillikOku('defter')]);
    const top = new Map();
    defter.forEach((e) => top.set(e.hesap, (top.get(e.hesap) || 0) + e.tutar));
    return { hesaplar, defter, bakiye: (h) => r2((h.acilis || 0) + (top.get(h.id) || 0)) };
  }

  /* ---------- cari bakiye ---------- */
  // bakiye > 0: karşı taraf bize borçlu (alacağımız), bakiye < 0: biz borçluyuz
  function cariHareketleri(cari, belgeler, odemeler) {
    const h = [];
    if (cari.acilis) h.push({ tarih: cari.olusturma.slice(0, 10), sira: 0, tur: 'acilis', aciklama: 'Açılış bakiyesi', tutar: cari.acilis, id: 'acilis' });
    belgeler.filter((b) => b.cari === cari.id && b.durum === 'acik' && b.tur !== 'irsaliye').forEach((b) => {
      h.push({ tarih: b.tarih, sira: 1, tur: b.tur === 'satis' ? 'satis' : 'alis', belge: b.no, haricNo: b.haricNo || '', aciklama: b.tur === 'satis' ? 'Satış faturası' : 'Alış faturası', tutar: b.tur === 'satis' ? b.toplam : -b.toplam, id: b.id });
    });
    odemeler.filter((o) => o.cari === cari.id).forEach((o) => {
      h.push({ tarih: o.tarih, sira: 2, tur: o.tur, aciklama: o.aciklama || (o.tur === 'tahsilat' ? 'Tahsilat' : 'Ödeme'), tutar: o.tur === 'tahsilat' ? -o.tutar : o.tutar, id: o.id });
    });
    h.sort((a, b) => (a.tarih < b.tarih ? -1 : a.tarih > b.tarih ? 1 : a.sira - b.sira));
    let bak = 0;
    h.forEach((x) => { bak = r2(bak + x.tutar); x.bakiye = bak; });
    return h;
  }

  /* ---------- fiyat ---------- */
  function listeFiyati(urun, liste) {
    if (!liste) return urun.perakende;
    if (liste.ozel && liste.ozel[urun.barkod] != null) return liste.ozel[urun.barkod];
    const taban = urun[liste.kaynak] != null ? urun[liste.kaynak] : urun.perakende;
    return r2(taban * (1 + (liste.yuzde || 0) / 100));
  }

  /* ---------- belge hesabı ---------- */
  function belgeHesapla(satirlar, iskonto, kdvDahil) {
    let ara = 0; let kdv = 0;
    satirlar.forEach((s) => {
      const brut = s.adet * s.fiyat;
      const net = kdvDahil ? brut / (1 + s.kdv / 100) : brut;
      ara += net; kdv += net * s.kdv / 100;
    });
    const isk = ara * iskonto / 100;
    const kdvSon = kdv * (1 - iskonto / 100);
    return { ara: r2(ara), iskontoTutar: r2(isk), kdvTutar: r2(kdvSon), toplam: r2(ara - isk + kdvSon) };
  }

  /* ---------- vade analizi (açık faturalar, ödemeler en eski faturadan düşülür) ---------- */
  function gunFarki(bugunStr, vade) { return Math.floor((Date.parse(bugunStr) - Date.parse(vade)) / 864e5); }
  function vadeAnaliz(cari, belgeler, odemeler, bugunStr) {
    const hesapla = (tur, odTur, isaret) => {
      const kalemler = [];
      if (cari.acilis && Math.sign(cari.acilis) === isaret) {
        kalemler.push({ id: 'acilis', no: 'Açılış bakiyesi', tarih: cari.olusturma.slice(0, 10), vade: '', toplam: Math.abs(cari.acilis) });
      }
      belgeler.filter((b) => b.cari === cari.id && b.durum === 'acik' && b.tur === tur)
        .sort((p, q) => (p.tarih < q.tarih ? -1 : p.tarih > q.tarih ? 1 : (p.t < q.t ? -1 : 1)))
        .forEach((b) => kalemler.push({ id: b.id, no: b.no, tarih: b.tarih, vade: b.vade || '', toplam: b.toplam }));
      let odenen = odemeler.filter((o) => o.cari === cari.id && o.tur === odTur).reduce((a, o) => a + o.tutar, 0);
      kalemler.forEach((k) => {
        const kapanan = Math.min(odenen, k.toplam); odenen = r2(odenen - kapanan);
        k.kalan = r2(k.toplam - kapanan);
      });
      return kalemler.filter((k) => k.kalan > 0.004).map((k) => ({ ...k, gecikmeGun: k.vade && k.vade < bugunStr ? gunFarki(bugunStr, k.vade) : 0 }));
    };
    return { alacak: hesapla('satis', 'tahsilat', 1), borc: hesapla('alis', 'odeme', -1) };
  }
  async function vadeOzeti() {
    const [cariler, belgeler, odemeler] = await Promise.all([listeOku('cariler'), yillikOku('belgeler'), yillikOku('odemeler')]);
    const bu = bugun();
    const sonuc = { gecikenTahsilat: { adet: 0, tutar: 0, liste: [] }, gecikenOdeme: { adet: 0, tutar: 0, liste: [] }, toplamAlacak: 0, toplamBorc: 0 };
    cariler.forEach((c) => {
      const a = vadeAnaliz(c, belgeler, odemeler, bu);
      a.alacak.forEach((k) => {
        sonuc.toplamAlacak += k.kalan;
        if (k.gecikmeGun > 0) { sonuc.gecikenTahsilat.adet++; sonuc.gecikenTahsilat.tutar += k.kalan; sonuc.gecikenTahsilat.liste.push({ cari: c.id, cariAd: c.ad, no: k.no, vade: k.vade, kalan: k.kalan, gun: k.gecikmeGun }); }
      });
      a.borc.forEach((k) => {
        sonuc.toplamBorc += k.kalan;
        if (k.gecikmeGun > 0) { sonuc.gecikenOdeme.adet++; sonuc.gecikenOdeme.tutar += k.kalan; sonuc.gecikenOdeme.liste.push({ cari: c.id, cariAd: c.ad, no: k.no, vade: k.vade, kalan: k.kalan, gun: k.gecikmeGun }); }
      });
    });
    ['gecikenTahsilat', 'gecikenOdeme'].forEach((k) => {
      sonuc[k].tutar = r2(sonuc[k].tutar);
      sonuc[k].liste.sort((p, q) => q.gun - p.gun);
      sonuc[k].liste = sonuc[k].liste.slice(0, 10);
    });
    sonuc.toplamAlacak = r2(sonuc.toplamAlacak); sonuc.toplamBorc = r2(sonuc.toplamBorc);
    return sonuc;
  }
  function cariDetayHesapla(cari, belgeler, odemeler) {
    const bu = bugun();
    const hareketler = cariHareketleri(cari, belgeler, odemeler);
    const satislar = belgeler.filter((b) => b.cari === cari.id && b.durum === 'acik' && b.tur === 'satis');
    const urunler = new Map();
    satislar.forEach((b) => b.satirlar.forEach((l) => {
      const k = l.barkod || ('hizmet:' + l.ad);
      const x = urunler.get(k) || { barkod: l.barkod || '', ad: l.ad, adet: 0, tutar: 0, sonTarih: '' };
      x.adet += l.adet; x.tutar += l.adet * l.fiyat; if (b.tarih > x.sonTarih) x.sonTarih = b.tarih;
      urunler.set(k, x);
    }));
    const a = vadeAnaliz(cari, belgeler, odemeler, bu);
    const alisverisler = satislar.slice().sort((p, q) => (p.tarih < q.tarih ? 1 : -1)).slice(0, 50)
      .map((b) => ({ id: b.id, no: b.no, tarih: b.tarih, toplam: b.toplam, kalemler: b.satirlar.map((l) => `${l.adet} × ${l.ad}`).join(', ') }));
    return {
      cari, bakiye: hareketler.length ? hareketler[hareketler.length - 1].bakiye : 0,
      toplamAlis: r2(satislar.reduce((x, b) => x + b.toplam, 0)), alisSayisi: satislar.length,
      sonAlis: satislar.reduce((m, b) => (b.tarih > m ? b.tarih : m), ''),
      acikAlacak: a.alacak, acikBorc: a.borc,
      geciken: r2(a.alacak.filter((k) => k.gecikmeGun > 0).reduce((x, k) => x + k.kalan, 0)),
      urunler: [...urunler.values()].map((x) => ({ ...x, adet: r2(x.adet), tutar: r2(x.tutar) })).sort((p, q) => (p.sonTarih < q.sonTarih ? 1 : -1)),
      alisverisler, hareketler
    };
  }

  /* ---------- yönlendirme ---------- */
  async function yonlendir(a, b, c2, d, yontem, req, url, user) {
    if (a === 'cariler') return cariRota(b, c2, yontem, req, url, user);
    if (a === 'hesaplar') return hesapRota(b, c2, yontem, req, user);
    if (a === 'odemeler') return odemeRota(b, yontem, req, url, user);
    if (a === 'belgeler') return belgeRota(b, c2, yontem, req, url, user);
    if (a === 'fiyat-listeleri') return fiyatRota(b, c2, yontem, req, url);
    if (a === 'backup') return yedekRota(b, yontem, user);
    return null;
  }

  /* ---------- cariler ---------- */
  function cariAlanlari(o, mevcut) {
    const ad = metin(o.ad, 120);
    if (!ad) return { hata: 'Cari adı gerekli' };
    const tur = CARI_TURLERI.includes(o.tur) ? o.tur : (mevcut ? mevcut.tur : 'musteri');
    let isk = sayi(o.iskonto, 0, 100); if (Number.isNaN(isk)) isk = 0;
    let acilis = sayi(o.acilis, -1e9, 1e9); if (Number.isNaN(acilis)) acilis = mevcut ? mevcut.acilis || 0 : 0;
    let vadeGun = sayi(o.vadeGun, 0, 365); if (Number.isNaN(vadeGun)) vadeGun = 0;
    return {
      veri: {
        vadeGun: Math.round(vadeGun),
        tur, ad, telefon: metin(o.telefon, 40), eposta: metin(o.eposta, 120), adres: metin(o.adres, 300),
        vergiNo: metin(o.vergiNo, 20), notlar: metin(o.notlar, 500), iskonto: r2(isk), acilis: r2(acilis),
        fiyatListesi: o.fiyatListesi ? String(o.fiyatListesi) : null
      }
    };
  }
  async function cariRota(b, c2, yontem, req, url) {
    if (!b && yontem === 'GET') {
      const [cariler, belgeler, odemeler] = await Promise.all([listeOku('cariler'), yillikOku('belgeler'), yillikOku('odemeler')]);
      const bu = bugun();
      return json(cariler.map((x) => {
        const h = cariHareketleri(x, belgeler, odemeler);
        const satislar = belgeler.filter((b) => b.cari === x.id && b.durum === 'acik' && b.tur === 'satis');
        const a = vadeAnaliz(x, belgeler, odemeler, bu);
        return {
          ...x, bakiye: h.length ? h[h.length - 1].bakiye : 0,
          sonAlis: satislar.reduce((m, b) => (b.tarih > m ? b.tarih : m), ''),
          toplamAlis: r2(satislar.reduce((t, b) => t + b.toplam, 0)),
          geciken: r2(a.alacak.filter((k) => k.gecikmeGun > 0).reduce((t, k) => t + k.kalan, 0)),
          gecikenBorc: r2(a.borc.filter((k) => k.gecikmeGun > 0).reduce((t, k) => t + k.kalan, 0))
        };
      }));
    }
    if (!b && yontem === 'POST') {
      const o = await govde(req); const r = cariAlanlari(o, null);
      if (r.hata) return hata(400, r.hata);
      const l = await listeOku('cariler');
      if (l.some((x) => x.ad.toLowerCase() === r.veri.ad.toLowerCase())) return hata(409, 'Bu isimde bir cari zaten var');
      const yeni = { id: uid(), aktif: true, olusturma: new Date().toISOString(), ...r.veri };
      l.push(yeni); await store.set('cariler', l);
      return json(yeni, 201);
    }
    if (b && c2 === 'detay' && yontem === 'GET') {
      const [cariler, belgeler, odemeler] = await Promise.all([listeOku('cariler'), yillikOku('belgeler'), yillikOku('odemeler')]);
      const cari = cariler.find((x) => x.id === b);
      if (!cari) return hata(404, 'Cari bulunamadı');
      return json(cariDetayHesapla(cari, belgeler, odemeler));
    }
    if (b && c2 === 'ekstre' && yontem === 'GET') {
      const [cariler, belgeler, odemeler] = await Promise.all([listeOku('cariler'), yillikOku('belgeler'), yillikOku('odemeler')]);
      const cari = cariler.find((x) => x.id === b);
      if (!cari) return hata(404, 'Cari bulunamadı');
      return json({ cari, hareketler: cariHareketleri(cari, belgeler, odemeler) });
    }
    if (b && !c2 && yontem === 'PUT') {
      const o = await govde(req); const l = await listeOku('cariler');
      const i = l.findIndex((x) => x.id === b);
      if (i < 0) return hata(404, 'Cari bulunamadı');
      const r = cariAlanlari(o, l[i]);
      if (r.hata) return hata(400, r.hata);
      if (l.some((x, j) => j !== i && x.ad.toLowerCase() === r.veri.ad.toLowerCase())) return hata(409, 'Bu isimde bir cari zaten var');
      l[i] = { ...l[i], ...r.veri, aktif: o.aktif === undefined ? l[i].aktif : Boolean(o.aktif) };
      await store.set('cariler', l);
      return json(l[i]);
    }
    if (b && !c2 && yontem === 'DELETE') {
      const l = await listeOku('cariler');
      if (!l.some((x) => x.id === b)) return hata(404, 'Cari bulunamadı');
      const [belgeler, odemeler] = await Promise.all([yillikOku('belgeler'), yillikOku('odemeler')]);
      if (belgeler.some((x) => x.cari === b) || odemeler.some((x) => x.cari === b)) return hata(400, 'Bu carinin kayıtları var. Silmek yerine pasifleştirin.');
      await store.set('cariler', l.filter((x) => x.id !== b));
      return json({ ok: true });
    }
    return hata(404, 'Bulunamadı');
  }

  /* ---------- hesaplar ---------- */
  async function hesapRota(b, c2, yontem, req, user) {
    if (!b && yontem === 'GET') {
      const { hesaplar, bakiye } = await hesapBakiyeleri();
      return json(hesaplar.map((h) => ({ ...h, bakiye: bakiye(h) })));
    }
    if (!b && yontem === 'POST') {
      const o = await govde(req); const ad = metin(o.ad, 80);
      if (!ad) return hata(400, 'Hesap adı gerekli');
      let acilis = sayi(o.acilis, -1e9, 1e9); if (Number.isNaN(acilis)) acilis = 0;
      const l = await listeOku('hesaplar');
      if (l.some((x) => x.ad.toLowerCase() === ad.toLowerCase())) return hata(409, 'Bu isimde bir hesap zaten var');
      const h = { id: uid(), ad, tur: HESAP_TURLERI.includes(o.tur) ? o.tur : 'kasa', acilis: r2(acilis), aktif: true, olusturma: new Date().toISOString() };
      l.push(h); await store.set('hesaplar', l);
      return json(h, 201);
    }
    if (b === 'transfer' && yontem === 'POST') {
      const o = await govde(req);
      const tutar = sayi(o.tutar, 0, 1e9);
      if (Number.isNaN(tutar) || tutar <= 0) return hata(400, 'Tutar sıfırdan büyük olmalı');
      const tarih = o.tarih || bugun(); if (!tarihGecerli(tarih)) return hata(400, 'Tarih geçersiz');
      const l = await listeOku('hesaplar');
      const k = l.find((x) => x.id === o.kaynak); const h = l.find((x) => x.id === o.hedef);
      if (!k || !h) return hata(400, 'Hesap bulunamadı');
      if (k.id === h.id) return hata(400, 'Aynı hesaba transfer yapılamaz');
      const ref = 'tr_' + uid();
      await defterEkle(k.id, -tutar, 'transfer', ref, `Transfer: ${h.ad}${o.aciklama ? ' · ' + o.aciklama : ''}`, tarih, user);
      await defterEkle(h.id, tutar, 'transfer', ref, `Transfer: ${k.ad}${o.aciklama ? ' · ' + o.aciklama : ''}`, tarih, user);
      return json({ ok: true, ref });
    }
    if (b && c2 === 'hareketler' && yontem === 'GET') {
      const { hesaplar, defter } = await hesapBakiyeleri();
      const h = hesaplar.find((x) => x.id === b);
      if (!h) return hata(404, 'Hesap bulunamadı');
      const l = defter.filter((e) => e.hesap === b).sort((p, q) => (p.tarih < q.tarih ? -1 : p.tarih > q.tarih ? 1 : (p.t < q.t ? -1 : 1)));
      let bak = h.acilis || 0;
      const sonuc = l.map((e) => { bak = r2(bak + e.tutar); return { ...e, bakiye: bak }; });
      return json({ hesap: h, hareketler: sonuc.reverse().slice(0, 500) });
    }
    if (b && c2 === 'duzeltme' && yontem === 'POST') {
      const o = await govde(req); const l = await listeOku('hesaplar');
      if (!l.some((x) => x.id === b)) return hata(404, 'Hesap bulunamadı');
      const tutar = sayi(o.tutar, -1e9, 1e9);
      if (Number.isNaN(tutar) || tutar === 0) return hata(400, 'Tutar girin (eksi değer de olabilir)');
      const aciklama = metin(o.aciklama, 200);
      if (aciklama.length < 3) return hata(400, 'Düzeltme nedenini yazın');
      return json(await defterEkle(b, tutar, 'duzeltme', null, 'Düzeltme: ' + aciklama, bugun(), user), 201);
    }
    if (b && !c2 && yontem === 'PUT') {
      const o = await govde(req); const l = await listeOku('hesaplar');
      const i = l.findIndex((x) => x.id === b);
      if (i < 0) return hata(404, 'Hesap bulunamadı');
      const ad = metin(o.ad, 80) || l[i].ad;
      if (l.some((x, j) => j !== i && x.ad.toLowerCase() === ad.toLowerCase())) return hata(409, 'Bu isimde bir hesap zaten var');
      l[i] = { ...l[i], ad, tur: HESAP_TURLERI.includes(o.tur) ? o.tur : l[i].tur, aktif: o.aktif === undefined ? l[i].aktif : Boolean(o.aktif) };
      const acilis = sayi(o.acilis, -1e9, 1e9); if (!Number.isNaN(acilis)) l[i].acilis = r2(acilis);
      await store.set('hesaplar', l);
      return json(l[i]);
    }
    if (b && !c2 && yontem === 'DELETE') {
      const { hesaplar, defter } = await hesapBakiyeleri();
      if (!hesaplar.some((x) => x.id === b)) return hata(404, 'Hesap bulunamadı');
      if (defter.some((e) => e.hesap === b)) return hata(400, 'Bu hesapta hareket var. Silmek yerine pasifleştirin.');
      await store.set('hesaplar', hesaplar.filter((x) => x.id !== b));
      return json({ ok: true });
    }
    return hata(404, 'Bulunamadı');
  }

  /* ---------- tahsilat / ödeme ---------- */
  async function odemeKaydet(o, user, belgeNo) {
    const tur = o.tur === 'odeme' ? 'odeme' : 'tahsilat';
    const tutar = sayi(o.tutar, 0, 1e9);
    if (Number.isNaN(tutar) || tutar <= 0) return { hata: 'Tutar sıfırdan büyük olmalı' };
    const tarih = o.tarih || bugun(); if (!tarihGecerli(tarih)) return { hata: 'Tarih geçersiz' };
    const [cariler, hesaplar] = await Promise.all([listeOku('cariler'), listeOku('hesaplar')]);
    const cari = cariler.find((x) => x.id === o.cari); const hesap = hesaplar.find((x) => x.id === o.hesap);
    if (!cari) return { hata: 'Cari seçin' };
    if (!hesap || !hesap.aktif) return { hata: 'Aktif bir kasa/banka hesabı seçin' };
    const id = uid();
    const defter = await defterEkle(hesap.id, tur === 'tahsilat' ? tutar : -tutar, tur, id,
      `${tur === 'tahsilat' ? 'Tahsilat' : 'Ödeme'}: ${cari.ad}${o.aciklama ? ' · ' + metin(o.aciklama, 100) : ''}`, tarih, user);
    const kayit = {
      id, t: new Date().toISOString(), tarih, tur, cari: cari.id, cariAd: cari.ad, hesap: hesap.id, hesapAd: hesap.ad, tutar: r2(tutar),
      aciklama: metin(o.aciklama, 200), belge: belgeNo || metin(o.belge, 40), defterId: defter.id, user: { id: user.id, name: user.name }
    };
    await yillikEkle('odemeler', tarih, kayit);
    return { kayit };
  }
  async function odemeRota(b, yontem, req, url, user) {
    if (!b && yontem === 'GET') {
      const cari = url.searchParams.get('cari');
      let l = await yillikOku('odemeler');
      if (cari) l = l.filter((x) => x.cari === cari);
      l.sort((p, q) => (p.tarih < q.tarih ? 1 : p.tarih > q.tarih ? -1 : (p.t < q.t ? 1 : -1)));
      return json(l.slice(0, 500));
    }
    if (!b && yontem === 'POST') {
      const r = await odemeKaydet(await govde(req), user);
      if (r.hata) return hata(400, r.hata);
      return json(r.kayit, 201);
    }
    if (b && yontem === 'DELETE') {
      const ok = await yillikGuncelle('odemeler', b, (l) => l.filter((x) => x.id !== b));
      if (!ok) return hata(404, 'Kayıt bulunamadı');
      await defterRefSil(b);
      return json({ ok: true });
    }
    return hata(404, 'Bulunamadı');
  }

  /* ---------- fatura / irsaliye ---------- */
  async function belgeOlustur(o, user) {
    const tur = o.tur;
    if (!BELGE_TURLERI[tur]) return { hata: 'Belge türü geçersiz' };
    const tarih = o.tarih || bugun(); if (!tarihGecerli(tarih)) return { hata: 'Tarih geçersiz' };
    const vade = o.vade ? String(o.vade) : '';
    if (vade && !tarihGecerli(vade)) return { hata: 'Vade tarihi geçersiz' };
    const cariler = await listeOku('cariler');
    const cari = cariler.find((x) => x.id === o.cari);
    if (!cari) return { hata: 'Cari seçin' };
    if (!Array.isArray(o.satirlar) || !o.satirlar.length) return { hata: 'En az bir kalem ekleyin' };
    if (o.satirlar.length > 200) return { hata: 'En fazla 200 kalem eklenebilir' };
    const stokIslem = o.stokIslem === undefined ? tur !== 'irsaliye' : Boolean(o.stokIslem);
    const kdvDahil = o.kdvDahil === undefined ? true : Boolean(o.kdvDahil);
    let iskonto = sayi(o.iskonto, 0, 100); if (Number.isNaN(iskonto)) iskonto = 0;
    const urunler = await store.get('products') || [];
    const satirlar = [];
    for (const s of o.satirlar) {
      const adet = sayi(s.adet, 0, 1e6); const fiyat = sayi(s.fiyat, 0, 1e9); let kdv = sayi(s.kdv, 0, 100);
      if (Number.isNaN(kdv)) kdv = 20;
      if (Number.isNaN(adet) || adet <= 0) return { hata: 'Kalem adedi sıfırdan büyük olmalı' };
      if (Number.isNaN(fiyat)) return { hata: 'Kalem fiyatı geçersiz' };
      const barkod = s.barkod ? String(s.barkod) : null;
      let ad = metin(s.ad, 160); let alis = 0;
      if (barkod) {
        const u = urunler.find((x) => x.barkod === barkod);
        if (!u) return { hata: `Ürün bulunamadı: ${barkod}` };
        ad = ad || u.ad; alis = u.alis;
        if (stokIslem && !Number.isInteger(adet)) return { hata: `${u.ad}: stoklu ürünün adedi tam sayı olmalı` };
      }
      if (!ad) return { hata: 'Kalem adı gerekli' };
      satirlar.push({ barkod, ad, adet: Number.isInteger(adet) ? adet : r2(adet), fiyat: r2(fiyat), kdv: r2(kdv), alis: r2(alis) });
    }
    // stok kontrolü (satış)
    if (stokIslem && tur !== 'alis') {
      const gerekli = new Map();
      satirlar.filter((s) => s.barkod).forEach((s) => gerekli.set(s.barkod, (gerekli.get(s.barkod) || 0) + s.adet));
      for (const [bk, ad] of gerekli) {
        const u = urunler.find((x) => x.barkod === bk);
        if (u.stok < ad) return { hata: `Yetersiz stok: ${u.ad} (stok ${u.stok}, gereken ${ad})` };
      }
    }
    const hesap = belgeHesapla(satirlar, iskonto, kdvDahil);
    const yil = Number(tarih.slice(0, 4));
    const no = `${BELGE_TURLERI[tur]}-${yil}-${String(await sayacAl(tur, yil)).padStart(4, '0')}`;
    const id = uid();
    // stok etkisi
    if (stokIslem) {
      for (const s of satirlar.filter((x) => x.barkod)) {
        const u = urunler.find((x) => x.barkod === s.barkod);
        const eski = u.stok;
        u.stok = tur === 'alis' ? eski + s.adet : eski - s.adet;
        if (tur === 'alis' && o.alisGuncelle) {
          const net = kdvDahil ? s.fiyat / (1 + s.kdv / 100) : s.fiyat;
          u.alis = r2(net * (1 - iskonto / 100));
        }
        await hareketYaz(user, u, eski, u.stok, 'fatura', `${no}: ${tur === 'alis' ? 'alış' : tur === 'satis' ? 'satış' : 'irsaliye'}`);
      }
      await store.set('products', urunler);
    }
    const belge = {
      id, no, tur, tarih, vade, cari: cari.id, cariAd: cari.ad, haricNo: metin(o.haricNo, 40), satirlar, iskonto: r2(iskonto), kdvDahil,
      ...hesap, stokIslem, alisGuncelle: tur === 'alis' && Boolean(o.alisGuncelle), durum: 'acik', notlar: metin(o.notlar, 500),
      t: new Date().toISOString(), user: { id: user.id, name: user.name }
    };
    await yillikEkle('belgeler', tarih, belge);
    // peşin ödeme / tahsilat
    const pesin = sayi(o.odenen, 0, 1e9);
    if (tur !== 'irsaliye' && !Number.isNaN(pesin) && pesin > 0) {
      const r = await odemeKaydet({ tur: tur === 'satis' ? 'tahsilat' : 'odeme', cari: cari.id, hesap: o.hesap, tutar: pesin, tarih, aciklama: `${no} peşin` }, user, no);
      if (r.hata) {
        // belgeyi geri al
        await belgeIptalEt(belge, user, true);
        return { hata: 'Peşin ödeme kaydedilemedi: ' + r.hata };
      }
      belge.odemeId = r.kayit.id;
      await yillikGuncelle('belgeler', id, (l) => l.map((x) => (x.id === id ? belge : x)));
    }
    return { belge };
  }
  async function belgeIptalEt(belge, user, sil) {
    if (belge.stokIslem) {
      const urunler = await store.get('products') || [];
      for (const s of belge.satirlar.filter((x) => x.barkod)) {
        const u = urunler.find((x) => x.barkod === s.barkod);
        if (!u) continue;
        const eski = u.stok;
        u.stok = belge.tur === 'alis' ? Math.max(0, eski - s.adet) : eski + s.adet;
        await hareketYaz(user, u, eski, u.stok, 'fatura', `${belge.no}: iptal`);
      }
      await store.set('products', urunler);
    }
    if (belge.odemeId) {
      await yillikGuncelle('odemeler', belge.odemeId, (l) => l.filter((x) => x.id !== belge.odemeId));
      await defterRefSil(belge.odemeId);
    }
    if (sil) await yillikGuncelle('belgeler', belge.id, (l) => l.filter((x) => x.id !== belge.id));
  }
  async function belgeRota(b, c2, yontem, req, url, user) {
    if (!b && yontem === 'GET') {
      const ay = url.searchParams.get('ay'); const cari = url.searchParams.get('cari'); const tur = url.searchParams.get('tur');
      let l = await yillikOku('belgeler');
      if (ay) l = l.filter((x) => x.tarih.slice(0, 7) === ay);
      if (cari) l = l.filter((x) => x.cari === cari);
      if (tur) l = l.filter((x) => x.tur === tur);
      l.sort((p, q) => (p.tarih < q.tarih ? 1 : p.tarih > q.tarih ? -1 : (p.t < q.t ? 1 : -1)));
      return json(l.slice(0, 1000));
    }
    if (!b && yontem === 'POST') {
      const r = await belgeOlustur(await govde(req), user);
      if (r.hata) return hata(400, r.hata);
      return json(r.belge, 201);
    }
    if (b && !c2 && yontem === 'GET') {
      const belge = (await yillikOku('belgeler')).find((x) => x.id === b);
      return belge ? json(belge) : hata(404, 'Belge bulunamadı');
    }
    if (b && c2 === 'iptal' && yontem === 'POST') {
      const belge = (await yillikOku('belgeler')).find((x) => x.id === b);
      if (!belge) return hata(404, 'Belge bulunamadı');
      if (belge.durum === 'iptal') return hata(400, 'Belge zaten iptal edilmiş');
      await belgeIptalEt(belge, user, false);
      const yeni = { ...belge, durum: 'iptal', iptalT: new Date().toISOString(), iptalEden: { id: user.id, name: user.name } };
      delete yeni.odemeId;
      await yillikGuncelle('belgeler', b, (l) => l.map((x) => (x.id === b ? yeni : x)));
      return json(yeni);
    }
    return hata(404, 'Bulunamadı');
  }

  /* ---------- fiyat listeleri ---------- */
  function listeAlanlari(o) {
    const ad = metin(o.ad, 80);
    if (!ad) return { hata: 'Liste adı gerekli' };
    if (!FIYAT_KAYNAKLARI.includes(o.kaynak)) return { hata: 'Fiyat kaynağı geçersiz' };
    let yuzde = sayi(o.yuzde, -99, 1000); if (Number.isNaN(yuzde)) yuzde = 0;
    const ozel = {};
    if (o.ozel && typeof o.ozel === 'object') {
      Object.keys(o.ozel).slice(0, 2000).forEach((k) => {
        const f = sayi(o.ozel[k], 0, 1e9);
        if (!Number.isNaN(f)) ozel[String(k).slice(0, 40)] = r2(f);
      });
    }
    return { veri: { ad, kaynak: o.kaynak, yuzde: r2(yuzde), ozel } };
  }
  async function fiyatRota(b, c2, yontem, req, url) {
    if (!b && yontem === 'GET') return json(await listeOku('fiyatlistesi'));
    if (b === 'hesapla' && yontem === 'GET') {
      const liste = (await listeOku('fiyatlistesi')).find((x) => x.id === url.searchParams.get('liste'));
      const u = ((await store.get('products')) || []).find((x) => x.barkod === url.searchParams.get('barkod'));
      if (!u) return hata(404, 'Ürün bulunamadı');
      return json({ barkod: u.barkod, fiyat: listeFiyati(u, liste) });
    }
    if (!b && yontem === 'POST') {
      const r = listeAlanlari(await govde(req));
      if (r.hata) return hata(400, r.hata);
      const l = await listeOku('fiyatlistesi');
      const yeni = { id: uid(), ...r.veri }; l.push(yeni);
      await store.set('fiyatlistesi', l);
      return json(yeni, 201);
    }
    if (b && !c2 && yontem === 'PUT') {
      const r = listeAlanlari(await govde(req));
      if (r.hata) return hata(400, r.hata);
      const l = await listeOku('fiyatlistesi'); const i = l.findIndex((x) => x.id === b);
      if (i < 0) return hata(404, 'Liste bulunamadı');
      l[i] = { id: b, ...r.veri };
      await store.set('fiyatlistesi', l);
      return json(l[i]);
    }
    if (b && !c2 && yontem === 'DELETE') {
      const l = await listeOku('fiyatlistesi');
      if (!l.some((x) => x.id === b)) return hata(404, 'Liste bulunamadı');
      await store.set('fiyatlistesi', l.filter((x) => x.id !== b));
      const cariler = await listeOku('cariler');
      if (cariler.some((x) => x.fiyatListesi === b)) await store.set('cariler', cariler.map((x) => (x.fiyatListesi === b ? { ...x, fiyatListesi: null } : x)));
      return json({ ok: true });
    }
    return hata(404, 'Bulunamadı');
  }

  /* ---------- yedek ---------- */
  async function anlikGoruntu() {
    const sabit = ['products', 'settings', 'jobs', 'cariler', 'hesaplar', 'fiyatlistesi', 'sayac'];
    const anahtarlar = [...sabit];
    const son = new Date().getUTCFullYear() + 1;
    for (let y = YIL_BASLANGIC; y <= son; y++) {
      ['belgeler', 'odemeler', 'defter', 'orders'].forEach((p) => anahtarlar.push(`${p}:${y}`));
      for (let m = 1; m <= 12; m++) {
        const ay = `${y}-${String(m).padStart(2, '0')}`;
        anahtarlar.push(`sales:${ay}`, `moves:${ay}`, `expenses:${ay}`);
      }
    }
    const gercek = anahtarlar;
    const degerler = await Promise.all(gercek.map((k) => store.get(k)));
    const veri = {};
    gercek.forEach((k, i) => { if (degerler[i] != null && !(Array.isArray(degerler[i]) && !degerler[i].length)) veri[k] = degerler[i]; });
    // kullanıcıların şifre özetleri yedeğe girmez
    const kul = (await store.get('users')) || [];
    veri.users = kul.map((u) => ({ id: u.id, username: u.username, name: u.name, role: u.role, active: u.active, created: u.created }));
    return veri;
  }
  async function yedekAl() {
    const veri = await anlikGoruntu();
    const tarih = bugun();
    await store.set('backup:' + tarih, { tarih, olusturma: new Date().toISOString(), veri });
    let liste = (await store.get('yedek-liste')) || [];
    liste = liste.filter((x) => x.tarih !== tarih);
    liste.push({ tarih, olusturma: new Date().toISOString(), anahtar: Object.keys(veri).length });
    liste.sort((p, q) => (p.tarih < q.tarih ? 1 : -1));
    const eskiler = liste.slice(YEDEK_SAKLA);
    for (const e of eskiler) await store.set('backup:' + e.tarih, null);
    await store.set('yedek-liste', liste.slice(0, YEDEK_SAKLA));
    return { tarih, anahtar: Object.keys(veri).length };
  }
  async function yedekRota(b, yontem) {
    if (!b && yontem === 'GET') return json((await store.get('yedek-liste')) || []);
    if (b === 'run' && yontem === 'POST') return json(await yedekAl());
    if (b === 'export' && yontem === 'GET') {
      return json({ tarih: bugun(), olusturma: new Date().toISOString(), veri: await anlikGoruntu() });
    }
    if (b && yontem === 'GET') {
      const y = await store.get('backup:' + b);
      return y ? json(y) : hata(404, 'Yedek bulunamadı');
    }
    return hata(404, 'Bulunamadı');
  }

  return {
    yonlendir, yedekAl, defterEkle, defterRefSil, belgeleriOku: () => yillikOku('belgeler'), listeFiyati, belgeHesapla, vadeOzeti
  };
}
