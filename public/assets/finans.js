// Yönetici paneli: Finans (cari, kasa/banka, fatura/irsaliye, fiyat listeleri, yedek)
// admin/index.html tarafından window.AD ile beslenir: { api, urunler(), toast }
(function () {
'use strict';
const { $, $$, esc, fmt, tarih, bugun, parseNum, toast } = AS;

const BELGE_AD = { satis: 'Satış faturası', alis: 'Alış faturası', irsaliye: 'İrsaliye' };
const CARI_AD = { musteri: 'Müşteri', tedarikci: 'Tedarikçi', ikisi: 'Müşteri / Tedarikçi' };
const KAYNAK_AD = { perakende: 'Perakende fiyatı', toptan: 'Toptan fiyatı', alis: 'Alış fiyatı' };
const HESAP_AD = { kasa: 'Kasa', banka: 'Banka' };
const AY_AD = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];

let sub = 'cari';
let gen = 0;
let C = [], H = [], L = [], B = [];
let cariAra = '', ekstre = null, cariForm = null, odemeCari = null, hesapForm = false, hesapHareket = null, duzeltmeId = null;
let belgeFiltre = { tur: '', ay: '' }, belgeDetay = null, bf = null, listeForm = null, silOnay = null;

const api = (...a) => AD.api(...a);
const kok = () => $('#mu-fin');
const urunler = () => AD.urunler();
const r2 = (n) => Math.round(n * 100) / 100;
const ayAnahtar = () => new Date(Date.now() + 3 * 36e5).toISOString().slice(0, 7);
const bakiyeHtml = (b) => b > 0 ? `<strong class="pos">${fmt(b)}</strong> <span class="muted">alacak</span>` : b < 0 ? `<strong class="neg">${fmt(-b)}</strong> <span class="muted">borç</span>` : '<span class="muted">-</span>';
const secenekler = (obj, sec) => Object.keys(obj).map((k) => `<option value="${esc(k)}"${k === sec ? ' selected' : ''}>${esc(obj[k])}</option>`).join('');
const cariAdi = (id) => (C.find((x) => x.id === id) || {}).ad || '-';
const listeBul = (id) => L.find((x) => x.id === id) || null;

function fiyatBul(u, liste) {
  if (!liste) return u.perakende;
  if (liste.ozel && liste.ozel[u.barkod] != null) return liste.ozel[u.barkod];
  const taban = u[liste.kaynak] != null ? u[liste.kaynak] : u.perakende;
  return r2(taban * (1 + (liste.yuzde || 0) / 100));
}
function belgeHesapla(kalemler, iskonto, kdvDahil) {
  let ara = 0, kdv = 0;
  kalemler.forEach((s) => {
    const brut = (s.adet || 0) * (s.fiyat || 0), net = kdvDahil ? brut / (1 + s.kdv / 100) : brut;
    ara += net; kdv += net * s.kdv / 100;
  });
  const isk = ara * iskonto / 100, kdvSon = kdv * (1 - iskonto / 100);
  return { ara: r2(ara), iskontoTutar: r2(isk), kdvTutar: r2(kdvSon), toplam: r2(ara - isk + kdvSon) };
}

function yazdir(baslik, html) {
  const w = window.open('', '_blank');
  if (!w) { toast('Yazdırma penceresi engellendi. Tarayıcıda bu site için açılır pencerelere izin verin.', 'bad'); return; }
  w.document.write(`<!doctype html><html lang="tr"><head><meta charset="utf-8"><title>${esc(baslik)}</title><style>
    body{font:13px/1.5 system-ui,Segoe UI,sans-serif;color:#111;margin:24px}
    h1{font-size:20px;margin:0}h2{font-size:16px;margin:16px 0 6px}
    table{border-collapse:collapse;width:100%;margin:8px 0}th,td{border-bottom:1px solid #ccc;padding:6px 8px;text-align:left}
    th{background:#f0f0f0;font-size:12px}.num{text-align:right}.top{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px}
    .muted{color:#666}.tot td{border:0}.tot{width:50%;margin-left:auto}
  </style></head><body>${html}<script>window.onload=function(){window.print()}<\/script></body></html>`);
  w.document.close();
}

/* ---------- yükleme ---------- */
async function yukle(...hangi) {
  const is = {
    cari: async () => { C = await api('cariler'); },
    hesap: async () => { H = await api('hesaplar'); },
    liste: async () => { L = await api('fiyat-listeleri'); }
  };
  await Promise.all(hangi.map((h) => is[h]()));
}

async function render(yeniSub) {
  const my = ++gen;
  if (yeniSub) { sub = yeniSub; silOnay = null; }
  const k = kok(); if (!k) return;
  const hedef = sub;
  try {
    if (hedef === 'cari') { await yukle('cari', 'liste', 'hesap'); if (my === gen) await cariCiz(); }
    else if (hedef === 'hesap') { await yukle('hesap'); if (my === gen) await hesapCiz(); }
    else if (hedef === 'belge') { await yukle('cari', 'liste', 'hesap'); if (my === gen) await belgeCiz(); }
    else if (hedef === 'liste') { await yukle('liste'); if (my === gen) listeCiz(); }
    else if (hedef === 'yedek') { if (my === gen) await yedekCiz(); }
  } catch (e) { toast(e.message, 'bad'); }
}

/* ======================= CARİ ======================= */
function cariCiz() {
  if (ekstre) return ekstreCiz();
  const alacak = C.reduce((a, x) => a + (x.bakiye > 0 ? x.bakiye : 0), 0);
  const borc = C.reduce((a, x) => a + (x.bakiye < 0 ? -x.bakiye : 0), 0);
  const q = cariAra.toLowerCase();
  const liste = C.filter((x) => !q || x.ad.toLowerCase().includes(q) || (x.telefon || '').includes(q));
  const aktifHesaplar = H.filter((h) => h.aktif);
  kok().innerHTML =
    `<div class="stats">`+
      `<div class="stat"><b>${C.length}</b><span>Cari sayısı</span></div>`+
      `<div class="stat"><b class="pos">${fmt(alacak)}</b><span>Toplam alacağımız</span></div>`+
      `<div class="stat"><b class="neg">${fmt(borc)}</b><span>Toplam borcumuz</span></div>`+
      `<div class="stat"><b>${fmt(alacak - borc)}</b><span>Net durum</span></div>`+
    `</div>`+
    (cariForm ? cariFormHtml() : '')+
    (odemeCari ? odemeFormHtml(aktifHesaplar) : '')+
    `<div class="card"><div class="head"><div><h2>Cari hesaplar</h2><p class="sub">Müşteri ve tedarikçileriniz, borç alacak durumları</p></div>`+
      `<div class="row"><label class="f">Ara<input type="search" id="fa-cariAra" value="${esc(cariAra)}" placeholder="Ad veya telefon"></label>`+
      `<button class="btn primary" data-fa="cari-yeni">Yeni cari</button></div></div>`+
      `<div class="tw"><table><thead><tr><th>Cari</th><th>Telefon</th><th>Son alışveriş</th><th class="num">Toplam alışveriş</th><th class="num">Vadesi geçen</th><th class="num">Bakiye</th><th></th></tr></thead><tbody>`+
      (liste.length ? liste.map((x) =>
        `<tr${x.aktif ? '' : ' style="opacity:.55"'}><td>${esc(x.ad)}${x.aktif ? '' : ' <span class="pill neutral">Pasif</span>'}${x.iskonto ? ` <span class="muted">· %${x.iskonto} iskonto</span>` : ''}</td><td>${esc(x.telefon || '-')}</td><td>${x.sonAlis ? tarih(x.sonAlis) : '-'}</td><td class="num">${x.toplamAlis ? fmt(x.toplamAlis) : '-'}</td><td class="num">${x.geciken ? `<span class="pill bad">${fmt(x.geciken)}</span>` : '-'}</td><td class="num">${bakiyeHtml(x.bakiye)}</td>`+
        `<td class="num"><span class="row" style="justify-content:flex-end;gap:6px"><button class="btn sm primary" data-fa="cari-detay" data-id="${esc(x.id)}">Detay</button><button class="btn sm" data-fa="cari-odeme" data-id="${esc(x.id)}">Tahsilat / ödeme</button><button class="btn sm" data-fa="cari-duzenle" data-id="${esc(x.id)}">Düzenle</button></span></td></tr>`
      ).join('') : `<tr><td colspan="7" class="empty">${C.length ? 'Aramanıza uyan cari yok.' : 'Henüz cari yok. Yeni cari ekleyin.'}</td></tr>`)+
      `</tbody></table></div></div>`;
}
function cariFormHtml() {
  const f = cariForm;
  return `<div class="card"><div class="head"><h2>${f.id ? 'Cariyi düzenle' : 'Yeni cari'}</h2></div><div class="formgrid">`+
    `<label class="f">Ad / ünvan<input id="cf-ad" value="${esc(f.ad || '')}" autocomplete="off"></label>`+
    `<label class="f">Tür<select id="cf-tur">${secenekler(CARI_AD, f.tur || 'musteri')}</select></label>`+
    `<label class="f">Telefon<input id="cf-telefon" value="${esc(f.telefon || '')}" inputmode="tel"></label>`+
    `<label class="f">E-posta<input id="cf-eposta" value="${esc(f.eposta || '')}"></label>`+
    `<label class="f">Vergi no / T.C.<input id="cf-vergiNo" value="${esc(f.vergiNo || '')}"></label>`+
    `<label class="f">Sabit iskonto (%)<input id="cf-iskonto" type="number" min="0" max="100" step="0.5" value="${f.iskonto || 0}"></label>`+
    `<label class="f">Vade (gün) <span style="font-weight:400">satışta otomatik vade</span><input id="cf-vadeGun" type="number" min="0" max="365" step="1" value="${f.vadeGun || 0}"></label>`+
    `<label class="f">Fiyat listesi<select id="cf-liste"><option value="">Standart (perakende)</option>${L.map((x) => `<option value="${esc(x.id)}"${x.id === f.fiyatListesi ? ' selected' : ''}>${esc(x.ad)}</option>`).join('')}</select></label>`+
    `<label class="f">Açılış bakiyesi (₺) <span style="font-weight:400">+ alacak, − borç</span><input id="cf-acilis" type="number" step="0.01" value="${f.acilis || 0}"></label>`+
    `<label class="f" style="grid-column:1/-1">Adres<input id="cf-adres" value="${esc(f.adres || '')}"></label>`+
    `<label class="f" style="grid-column:1/-1">Not<input id="cf-notlar" value="${esc(f.notlar || '')}"></label>`+
    (f.id ? `<label class="chk"><input type="checkbox" id="cf-aktif"${f.aktif ? ' checked' : ''}> Aktif</label>` : '')+
    `</div><div class="row" style="margin-top:14px"><button class="btn primary" data-fa="cari-kaydet">Kaydet</button><button class="btn" data-fa="cari-vazgec">Vazgeç</button>`+
    (f.id ? `<button class="btn danger" data-fa="cari-sil">${silOnay === 'cari' ? 'Emin misiniz? Tekrar tıklayın' : 'Sil'}</button>` : '')+`</div></div>`;
}
function odemeFormHtml(aktifHesaplar) {
  const x = C.find((c) => c.id === odemeCari.id) || {};
  return `<div class="card"><div class="head"><div><h2>Tahsilat / ödeme: ${esc(x.ad || '')}</h2><p class="sub">Güncel bakiye: ${bakiyeHtml(x.bakiye || 0)}</p></div></div>`+
    (aktifHesaplar.length ? `<div class="formgrid">`+
    `<label class="f">İşlem<select id="of-tur"><option value="tahsilat"${odemeCari.tur === 'tahsilat' ? ' selected' : ''}>Tahsilat (para aldım)</option><option value="odeme"${odemeCari.tur === 'odeme' ? ' selected' : ''}>Ödeme (para verdim)</option></select></label>`+
    `<label class="f">Hesap<select id="of-hesap">${aktifHesaplar.map((h) => `<option value="${esc(h.id)}">${esc(h.ad)} (${HESAP_AD[h.tur]})</option>`).join('')}</select></label>`+
    `<label class="f">Tutar (₺)<input id="of-tutar" type="number" min="0" step="0.01"></label>`+
    `<label class="f">Tarih<input id="of-tarih" type="date" value="${bugun()}"></label>`+
    `<label class="f" style="grid-column:1/-1">Açıklama<input id="of-aciklama" autocomplete="off"></label></div>`+
    `<div class="row" style="margin-top:14px"><button class="btn primary" data-fa="odeme-kaydet">Kaydet</button><button class="btn" data-fa="odeme-vazgec">Vazgeç</button></div>`
    : `<div class="note warn">Önce Kasa ve banka sekmesinden bir hesap ekleyin.</div><div class="row" style="margin-top:12px"><button class="btn" data-fa="odeme-vazgec">Kapat</button></div>`)+
    `</div>`;
}
async function ekstreCiz() {
  const my = gen;
  const d = await api(`cariler/${ekstre}/detay`);
  const c = d.cari;
  const son = d.hareketler.length ? d.hareketler[d.hareketler.length - 1].bakiye : 0;
  const acikTablo = (l, bos) => `<div class="tw"><table><thead><tr><th>Belge</th><th>Tarih</th><th>Vade</th><th class="num">Toplam</th><th class="num">Kalan</th><th class="num">Gecikme</th></tr></thead><tbody>`+
    (l.length ? l.map((k) => `<tr><td class="mono">${esc(k.no)}</td><td>${tarih(k.tarih)}</td><td>${k.vade ? tarih(k.vade) : '-'}</td><td class="num">${fmt(k.toplam)}</td><td class="num"><strong>${fmt(k.kalan)}</strong></td><td class="num">${k.gecikmeGun > 0 ? `<span class="pill bad">${k.gecikmeGun} gün</span>` : '-'}</td></tr>`).join('') : `<tr><td colspan="6" class="empty">${bos}</td></tr>`)+`</tbody></table></div>`;
  const hareketler = d.hareketler.slice().reverse().map((h) =>
    `<tr><td>${tarih(h.tarih)}</td><td>${esc(h.aciklama)}${h.belge ? ` <span class="mono muted">${esc(h.belge)}</span>` : ''}</td>`+
    `<td class="num">${h.tutar > 0 ? fmt(h.tutar) : ''}</td><td class="num">${h.tutar < 0 ? fmt(-h.tutar) : ''}</td><td class="num">${bakiyeHtml(h.bakiye)}</td>`+
    `<td class="num">${h.tur === 'tahsilat' || h.tur === 'odeme' ? `<button class="btn sm" data-fa="odeme-sil" data-id="${esc(h.id)}">Sil</button>` : ''}</td></tr>`).join('');
  if (my !== gen) return;
  kok().innerHTML =
    `<div class="card"><div class="head"><div><h2>${esc(c.ad)}</h2><p class="sub">${esc(CARI_AD[c.tur] || '')}${c.telefon ? ' · ' + esc(c.telefon) : ''}${c.adres ? ' · ' + esc(c.adres) : ''}${c.iskonto ? ' · %' + c.iskonto + ' iskonto' : ''}${c.vadeGun ? ' · ' + c.vadeGun + ' gün vade' : ''}</p></div>`+
    `<div class="row"><button class="btn primary" data-fa="cari-satis" data-id="${esc(c.id)}">Satış yap</button><button class="btn" data-fa="cari-tahsilat" data-id="${esc(c.id)}">Tahsilat / ödeme</button><button class="btn" data-fa="ekstre-duzenle" data-id="${esc(c.id)}">Düzenle</button><button class="btn" data-fa="ekstre-yazdir">Ekstre yazdır</button><button class="btn" data-fa="ekstre-kapat">Geri</button></div></div>`+
    `<div class="stats"><div class="stat"><b>${bakiyeHtml(d.bakiye)}</b><span>Güncel bakiye</span></div>`+
    `<div class="stat"><b>${fmt(d.toplamAlis)}</b><span>Toplam alışveriş (${d.alisSayisi} fatura)</span></div>`+
    `<div class="stat"><b>${d.sonAlis ? tarih(d.sonAlis) : '-'}</b><span>Son alışveriş</span></div>`+
    `<div class="stat"><b class="${d.geciken ? 'neg' : ''}">${fmt(d.geciken)}</b><span>Vadesi geçen borç</span></div></div></div>`+
    `<div class="card"><div class="head"><h2>Ödenmemiş faturalar</h2></div>${acikTablo(d.acikAlacak, 'Ödenmemiş fatura yok.')}`+
      (d.acikBorc.length ? `<h3 style="margin:14px 0 6px">Bizim ödemediğimiz alışlar</h3>${acikTablo(d.acikBorc, '')}` : '')+`</div>`+
    `<div class="card"><div class="head"><h2>Aldığı ürünler</h2></div><div class="tw"><table><thead><tr><th>Ürün</th><th class="num">Toplam adet</th><th class="num">Tutar</th><th>Son alış</th></tr></thead><tbody>`+
      (d.urunler.length ? d.urunler.map((u) => `<tr><td>${esc(u.ad)}${u.barkod ? ` <span class="mono muted">${esc(u.barkod)}</span>` : ''}</td><td class="num">${u.adet}</td><td class="num">${fmt(u.tutar)}</td><td>${tarih(u.sonTarih)}</td></tr>`).join('') : '<tr><td colspan="4" class="empty">Henüz ürün satışı yok.</td></tr>')+`</tbody></table></div></div>`+
    `<div class="card"><div class="head"><h2>Alışveriş geçmişi</h2></div><div class="tw"><table><thead><tr><th>Fatura</th><th>Tarih</th><th>Kalemler</th><th class="num">Tutar</th></tr></thead><tbody>`+
      (d.alisverisler.length ? d.alisverisler.map((b) => `<tr><td><a href="#" class="mono" data-fa="detay-belge" data-id="${esc(b.id)}">${esc(b.no)}</a></td><td>${tarih(b.tarih)}</td><td>${esc(b.kalemler)}</td><td class="num">${fmt(b.toplam)}</td></tr>`).join('') : '<tr><td colspan="4" class="empty">Henüz fatura yok.</td></tr>')+`</tbody></table></div></div>`+
    `<div class="card"><div class="head"><div><h2>Hesap hareketleri</h2><p class="sub">Borç sütunu bize yazılan (satış, ödeme), alacak sütunu bizden düşen (tahsilat, alış) tutarlardır.</p></div></div><div class="tw"><table><thead><tr><th>Tarih</th><th>Açıklama</th><th class="num">Borç</th><th class="num">Alacak</th><th class="num">Bakiye</th><th></th></tr></thead><tbody>${hareketler || '<tr><td colspan="6" class="empty">Hareket yok.</td></tr>'}</tbody></table></div></div>`;
  kok().dataset.ekstre = JSON.stringify({ ad: c.ad, son, h: d.hareketler });
}
function ekstreYazdir() {
  const e = JSON.parse(kok().dataset.ekstre || '{}');
  const s = (e.h || []).map((h) => `<tr><td>${tarih(h.tarih)}</td><td>${esc(h.aciklama)} ${esc(h.belge || '')}</td><td class="num">${h.tutar > 0 ? fmt(h.tutar) : ''}</td><td class="num">${h.tutar < 0 ? fmt(-h.tutar) : ''}</td><td class="num">${fmt(h.bakiye)}</td></tr>`).join('');
  yazdir('Ekstre ' + e.ad, `<div class="top"><div><h1>RO-STAR</h1><div class="muted">Cari hesap ekstresi</div></div><div>${tarih(bugun())}</div></div><h2>${esc(e.ad)}</h2><table><thead><tr><th>Tarih</th><th>Açıklama</th><th class="num">Borç</th><th class="num">Alacak</th><th class="num">Bakiye</th></tr></thead><tbody>${s}</tbody></table><p><strong>Güncel bakiye: ${fmt(e.son)}</strong> ${e.son > 0 ? '(alacağımız)' : e.son < 0 ? '(borcumuz)' : ''}</p>`);
}
async function cariKaydet() {
  const g = (id) => $('#cf-' + id).value;
  const o = { ad: g('ad'), tur: g('tur'), telefon: g('telefon'), eposta: g('eposta'), vergiNo: g('vergiNo'), adres: g('adres'), notlar: g('notlar'),
    iskonto: parseNum(g('iskonto')) || 0, vadeGun: parseNum(g('vadeGun')) || 0, acilis: parseNum(g('acilis')) || 0, fiyatListesi: g('liste') || null };
  if (cariForm.id) o.aktif = $('#cf-aktif').checked;
  try {
    await api(cariForm.id ? 'cariler/' + encodeURIComponent(cariForm.id) : 'cariler', { method: cariForm.id ? 'PUT' : 'POST', body: o });
    cariForm = null; toast('Cari kaydedildi'); render();
  } catch (e) { toast(e.message, 'bad'); }
}

/* ======================= KASA / BANKA ======================= */
async function hesapCiz() {
  const my = gen;
  if (hesapHareket) return hesapHareketCiz();
  const toplam = H.filter((h) => h.aktif).reduce((a, h) => a + h.bakiye, 0);
  let ayar = {}; try { ayar = await api('settings'); } catch (e) { /* */ }
  if (my !== gen) return;
  kok().innerHTML =
    `<div class="stats"><div class="stat"><b>${fmt(toplam)}</b><span>Toplam nakit (aktif hesaplar)</span></div>`+
    H.filter((h) => h.aktif).map((h) => `<div class="stat"><b class="${h.bakiye < 0 ? 'neg' : ''}">${fmt(h.bakiye)}</b><span>${esc(h.ad)}</span></div>`).join('')+`</div>`+
    (hesapForm ? `<div class="card"><div class="head"><h2>Yeni hesap</h2></div><div class="formgrid">`+
      `<label class="f">Hesap adı<input id="hf-ad" placeholder="Örn. Kasa, Ziraat Bankası"></label>`+
      `<label class="f">Tür<select id="hf-tur">${secenekler(HESAP_AD, 'kasa')}</select></label>`+
      `<label class="f">Açılış bakiyesi (₺)<input id="hf-acilis" type="number" step="0.01" value="0"></label></div>`+
      `<div class="row" style="margin-top:14px"><button class="btn primary" data-fa="hesap-kaydet">Kaydet</button><button class="btn" data-fa="hesap-vazgec">Vazgeç</button></div></div>` : '')+
    (duzeltmeId ? `<div class="card"><div class="head"><div><h2>Bakiye düzeltme: ${esc((H.find((h) => h.id === duzeltmeId) || {}).ad || '')}</h2><p class="sub">Sayım farkı gibi durumlarda bakiyeyi artırır (+) veya azaltır (−). Neden zorunlu.</p></div></div>`+
      `<div class="row"><label class="f">Tutar (₺, eksi olabilir)<input id="du-tutar" type="number" step="0.01"></label><label class="f" style="flex:1 1 260px">Neden<input id="du-neden" placeholder="Örn. Kasa sayım farkı"></label>`+
      `<button class="btn primary" data-fa="duzeltme-kaydet">Kaydet</button><button class="btn" data-fa="duzeltme-vazgec">Vazgeç</button></div></div>` : '')+
    `<div class="card"><div class="head"><div><h2>Kasa ve banka hesapları</h2></div><button class="btn primary" data-fa="hesap-yeni">Yeni hesap</button></div>`+
      `<div class="tw"><table><thead><tr><th>Hesap</th><th>Tür</th><th class="num">Bakiye</th><th></th></tr></thead><tbody>`+
      (H.length ? H.map((h) => `<tr${h.aktif ? '' : ' style="opacity:.55"'}><td>${esc(h.ad)}${h.aktif ? '' : ' <span class="pill neutral">Pasif</span>'}</td><td>${HESAP_AD[h.tur]}</td><td class="num"><strong class="${h.bakiye < 0 ? 'neg' : ''}">${fmt(h.bakiye)}</strong></td>`+
        `<td class="num"><span class="row" style="justify-content:flex-end;gap:6px"><button class="btn sm" data-fa="hesap-hareket" data-id="${esc(h.id)}">Hareketler</button><button class="btn sm" data-fa="hesap-duzeltme" data-id="${esc(h.id)}">Düzeltme</button><button class="btn sm" data-fa="hesap-pasif" data-id="${esc(h.id)}">${h.aktif ? 'Pasifleştir' : 'Aktifleştir'}</button></span></td></tr>`).join('')
        : '<tr><td colspan="4" class="empty">Henüz hesap yok. Yeni hesap ekleyin (örneğin Kasa).</td></tr>')+
      `</tbody></table></div></div>`+
    `<div class="grid2"><div class="card"><h3 style="margin-bottom:8px">Hesaplar arası transfer</h3>`+
      (H.filter((h) => h.aktif).length >= 2 ? `<div class="row"><label class="f">Kaynak<select id="tf-kaynak">${H.filter((h) => h.aktif).map((h) => `<option value="${esc(h.id)}">${esc(h.ad)}</option>`).join('')}</select></label>`+
        `<label class="f">Hedef<select id="tf-hedef">${H.filter((h) => h.aktif).map((h, i) => `<option value="${esc(h.id)}"${i === 1 ? ' selected' : ''}>${esc(h.ad)}</option>`).join('')}</select></label>`+
        `<label class="f">Tutar (₺)<input id="tf-tutar" type="number" min="0" step="0.01"></label><button class="btn primary" data-fa="transfer">Transfer et</button></div>` : '<p class="muted" style="margin:0">Transfer için en az iki aktif hesap gerekir.</p>')+
    `</div><div class="card"><h3 style="margin-bottom:6px">Barkodlu satışlar nereye yazılsın?</h3><p class="sub" style="margin-bottom:8px">Seçtiğiniz hesaba her barkodlu satış tutarı otomatik eklenir.</p>`+
      `<label class="f"><select id="tf-satisHesap"><option value="">Hiçbirine (kasaya işlenmesin)</option>${H.filter((h) => h.aktif).map((h) => `<option value="${esc(h.id)}"${h.id === ayar.satisHesap ? ' selected' : ''}>${esc(h.ad)}</option>`).join('')}</select></label></div></div>`;
}
async function hesapHareketCiz() {
  const my = gen;
  const d = await api(`hesaplar/${hesapHareket}/hareketler`);
  if (my !== gen) return;
  kok().innerHTML = `<div class="card"><div class="head"><div><h2>Hareketler: ${esc(d.hesap.ad)}</h2><p class="sub">Son ${d.hareketler.length} hareket</p></div><button class="btn" data-fa="hareket-kapat">Geri</button></div>`+
    `<div class="tw"><table><thead><tr><th>Tarih</th><th>Açıklama</th><th class="num">Giriş</th><th class="num">Çıkış</th><th class="num">Bakiye</th></tr></thead><tbody>`+
    (d.hareketler.length ? d.hareketler.map((e) => `<tr><td>${tarih(e.tarih)}</td><td>${esc(e.aciklama || e.tur)}</td><td class="num pos">${e.tutar > 0 ? fmt(e.tutar) : ''}</td><td class="num neg">${e.tutar < 0 ? fmt(-e.tutar) : ''}</td><td class="num">${fmt(e.bakiye)}</td></tr>`).join('') : '<tr><td colspan="5" class="empty">Hareket yok.</td></tr>')+
    `</tbody></table></div></div>`;
}

/* ======================= FATURA / İRSALİYE ======================= */
async function belgeCiz() {
  const my = gen;
  if (bf) return belgeFormCiz();
  if (belgeDetay) return belgeDetayCiz();
  if (!belgeFiltre.ay) belgeFiltre.ay = ayAnahtar();
  B = await api(`belgeler?ay=${belgeFiltre.ay}${belgeFiltre.tur ? '&tur=' + belgeFiltre.tur : ''}`);
  const gecerli = B.filter((x) => x.durum === 'acik');
  const satis = gecerli.filter((x) => x.tur === 'satis').reduce((a, x) => a + x.toplam, 0);
  const alis = gecerli.filter((x) => x.tur === 'alis').reduce((a, x) => a + x.toplam, 0);
  const [y, m] = belgeFiltre.ay.split('-');
  if (my !== gen) return;
  kok().innerHTML =
    `<div class="stats"><div class="stat"><b>${gecerli.filter((x) => x.tur === 'satis').length}</b><span>Satış faturası</span></div><div class="stat"><b>${fmt(satis)}</b><span>Satış toplamı (KDV dahil)</span></div>`+
    `<div class="stat"><b>${gecerli.filter((x) => x.tur === 'alis').length}</b><span>Alış faturası</span></div><div class="stat"><b>${fmt(alis)}</b><span>Alış toplamı (KDV dahil)</span></div></div>`+
    `<div class="card"><div class="head"><div><h2>Fatura ve irsaliyeler</h2><p class="sub">${AY_AD[+m - 1]} ${y}. Bunlar sistem içi kayıtlardır, resmi e-fatura yerine geçmez.</p></div>`+
      `<div class="row"><label class="f">Ay<input type="month" id="bl-ay" value="${esc(belgeFiltre.ay)}"></label>`+
      `<label class="f">Tür<select id="bl-tur"><option value="">Tümü</option>${secenekler(BELGE_AD, belgeFiltre.tur)}</select></label>`+
      `<button class="btn primary" data-fa="belge-yeni">Yeni belge</button></div></div>`+
      `<div class="tw"><table><thead><tr><th>No</th><th>Tür</th><th>Tarih</th><th>Cari</th><th>Vade</th><th class="num">Toplam</th><th>Durum</th></tr></thead><tbody>`+
      (B.length ? B.map((x) => `<tr><td><a href="#" data-fa="belge-ac" data-id="${esc(x.id)}" class="mono">${esc(x.no)}</a></td><td>${BELGE_AD[x.tur]}</td><td>${tarih(x.tarih)}</td><td>${esc(x.cariAd)}</td><td>${x.vade ? tarih(x.vade) : '-'}</td><td class="num">${fmt(x.toplam)}</td><td>${x.durum === 'iptal' ? '<span class="pill bad">İptal</span>' : '<span class="pill good">Geçerli</span>'}</td></tr>`).join('')
        : '<tr><td colspan="7" class="empty">Bu ay belge yok.</td></tr>')+
      `</tbody></table></div></div>`;
}
function vadeHesapla(tarihStr, gun) {
  if (!gun || !tarihStr) return '';
  const d = new Date(tarihStr + 'T12:00:00'); d.setDate(d.getDate() + Number(gun));
  return d.toISOString().slice(0, 10);
}
function belgeYeni() {
  bf = { tur: 'satis', cari: '', tarih: bugun(), vade: '', haricNo: '', iskonto: 0, kdvDahil: true, stokIslem: true, alisGuncelle: false, odenen: '', hesap: '', notlar: '', kalemler: [{ barkod: '', ad: '', adet: 1, fiyat: 0, kdv: 20 }] };
  belgeCiz();
}
function cariSecenekleri(tur) {
  const uygun = C.filter((x) => x.aktif && (tur === 'alis' ? x.tur !== 'musteri' : x.tur !== 'tedarikci'));
  return `<option value="">Seçin</option>` + uygun.map((x) => `<option value="${esc(x.id)}"${x.id === bf.cari ? ' selected' : ''}>${esc(x.ad)}</option>`).join('');
}
function belgeFormCiz() {
  const aktifH = H.filter((h) => h.aktif);
  kok().innerHTML = `<div class="card"><div class="head"><h2>Yeni belge</h2><button class="btn" data-fa="belge-vazgec">Vazgeç</button></div>`+
    `<div class="formgrid">`+
    `<label class="f">Tür<select id="bd-tur">${secenekler(BELGE_AD, bf.tur)}</select></label>`+
    `<label class="f">Cari<select id="bd-cari">${cariSecenekleri(bf.tur)}</select></label>`+
    `<label class="f">Tarih<input id="bd-tarih" type="date" value="${esc(bf.tarih)}"></label>`+
    `<label class="f">Vade (isteğe bağlı)<input id="bd-vade" type="date" value="${esc(bf.vade)}"></label>`+
    `<label class="f">${bf.tur === 'alis' ? 'Tedarikçi fatura no' : 'Harici belge no'}<input id="bd-haricNo" value="${esc(bf.haricNo)}" autocomplete="off"></label>`+
    `<label class="f">İskonto (%)<input id="bd-iskonto" type="number" min="0" max="100" step="0.5" value="${bf.iskonto}"></label></div>`+
    `<h3 style="margin:16px 0 6px">Kalemler</h3>`+
    `<div class="tw"><table><thead><tr><th>Ürün (barkod / ad) veya hizmet</th><th class="num">Adet</th><th class="num">Birim fiyat</th><th class="num">KDV %</th><th class="num">Tutar</th><th></th></tr></thead><tbody id="bd-kalemler"></tbody></table></div>`+
    `<div class="row" style="margin-top:8px"><button class="btn sm" data-fa="kalem-ekle">Kalem ekle</button></div>`+
    `<div class="row" style="margin-top:14px">`+
      `<label class="chk"><input type="checkbox" id="bd-kdvDahil"${bf.kdvDahil ? ' checked' : ''}> Fiyatlar KDV dahil</label>`+
      `<label class="chk"><input type="checkbox" id="bd-stok"${bf.stokIslem ? ' checked' : ''}> Stoğa işle</label>`+
      (bf.tur === 'alis' ? `<label class="chk"><input type="checkbox" id="bd-alisGuncelle"${bf.alisGuncelle ? ' checked' : ''}> Ürünlerin alış fiyatını bu faturaya göre güncelle</label>` : '')+
    `</div>`+
    (bf.tur !== 'irsaliye' ? `<div class="row" style="margin-top:12px"><label class="f">${bf.tur === 'satis' ? 'Peşin tahsil edilen' : 'Peşin ödenen'} (₺, isteğe bağlı)<input id="bd-odenen" type="number" min="0" step="0.01" value="${esc(bf.odenen)}"></label>`+
      `<label class="f">Hesap<select id="bd-hesap"><option value="">Seçin</option>${aktifH.map((h) => `<option value="${esc(h.id)}"${h.id === bf.hesap ? ' selected' : ''}>${esc(h.ad)}</option>`).join('')}</select></label></div>` : '')+
    `<label class="f" style="margin-top:12px">Not<input id="bd-notlar" value="${esc(bf.notlar)}"></label>`+
    `<div class="sum" id="bd-toplam" style="margin-top:14px"></div>`+
    `<div class="row" style="margin-top:14px"><button class="btn primary" data-fa="belge-kaydet">Belgeyi kaydet</button><button class="btn" data-fa="belge-vazgec">Vazgeç</button></div></div>`;
  kalemleriCiz(); toplamGuncelle();
}
function kalemleriCiz() {
  $('#bd-kalemler').innerHTML = bf.kalemler.map((k, i) =>
    `<tr><td><input data-k="${i}:ad" list="urunListesi" value="${esc(k.barkod || k.ad)}" placeholder="Barkod okutun veya ad yazın" style="width:100%;min-width:200px"></td>`+
    `<td class="num"><input data-k="${i}:adet" type="number" min="0" step="1" value="${k.adet}" style="width:80px"></td>`+
    `<td class="num"><input data-k="${i}:fiyat" type="number" min="0" step="0.01" value="${k.fiyat}" style="width:110px"></td>`+
    `<td class="num"><input data-k="${i}:kdv" type="number" min="0" max="100" step="1" value="${k.kdv}" style="width:70px"></td>`+
    `<td class="num" data-tutar="${i}">${fmt((k.adet || 0) * (k.fiyat || 0))}</td>`+
    `<td class="num"><button class="btn sm" data-fa="kalem-sil" data-i="${i}">Sil</button></td></tr>`).join('');
}
function toplamGuncelle() {
  const t = belgeHesapla(bf.kalemler, bf.iskonto || 0, bf.kdvDahil);
  const el = $('#bd-toplam'); if (!el) return;
  el.innerHTML = `<div><span>Ara toplam (KDV hariç)</span><strong>${fmt(t.ara)}</strong></div>`+
    (t.iskontoTutar ? `<div><span>İskonto</span><strong>− ${fmt(t.iskontoTutar)}</strong></div>` : '')+
    `<div><span>KDV</span><strong>${fmt(t.kdvTutar)}</strong></div><div class="tot"><span>Genel toplam</span><strong>${fmt(t.toplam)}</strong></div>`;
  bf.kalemler.forEach((k, i) => { const h = document.querySelector(`[data-tutar="${i}"]`); if (h) h.textContent = fmt((k.adet || 0) * (k.fiyat || 0)); });
}
function kalemUrunSec(i, deger) {
  const k = bf.kalemler[i]; const v = String(deger).trim();
  const u = urunler().find((x) => x.barkod === v) || urunler().find((x) => x.ad.toLowerCase() === v.toLowerCase());
  if (u) {
    k.barkod = u.barkod; k.ad = u.ad;
    const cari = C.find((x) => x.id === bf.cari);
    k.fiyat = bf.tur === 'alis' ? u.alis : fiyatBul(u, cari ? listeBul(cari.fiyatListesi) : null);
    if (bf.tur === 'alis') { /* alış fiyatı çoğunlukla KDV hariç girilir */ }
  } else { k.barkod = ''; k.ad = v; }
}
async function belgeKaydet() {
  const o = { tur: bf.tur, cari: bf.cari, tarih: bf.tarih, vade: bf.vade || undefined, haricNo: bf.haricNo, iskonto: bf.iskonto || 0, kdvDahil: bf.kdvDahil,
    stokIslem: bf.stokIslem, alisGuncelle: bf.alisGuncelle, notlar: bf.notlar, odenen: parseNum(bf.odenen) || 0, hesap: bf.hesap || undefined,
    satirlar: bf.kalemler.filter((k) => k.barkod || k.ad).map((k) => ({ barkod: k.barkod || undefined, ad: k.ad, adet: k.adet, fiyat: k.fiyat, kdv: k.kdv })) };
  try {
    const b = await api('belgeler', { method: 'POST', body: o });
    bf = null; belgeDetay = b.id; toast(`${b.no} kaydedildi`);
    if (AD.urunleriYenile) await AD.urunleriYenile();
    belgeCiz();
  } catch (e) { toast(e.message, 'bad'); }
}
async function belgeDetayCiz() {
  const my = gen;
  const b = await api('belgeler/' + encodeURIComponent(belgeDetay));
  const satirlar = b.satirlar.map((s) => `<tr><td>${esc(s.ad)}${s.barkod ? ` <span class="mono muted">${esc(s.barkod)}</span>` : ''}</td><td class="num">${s.adet}</td><td class="num">${fmt(s.fiyat)}</td><td class="num">%${s.kdv}</td><td class="num">${fmt(s.adet * s.fiyat)}</td></tr>`).join('');
  const toplamlar = `<div><span>Ara toplam</span><strong>${fmt(b.ara)}</strong></div>${b.iskontoTutar ? `<div><span>İskonto (%${b.iskonto})</span><strong>− ${fmt(b.iskontoTutar)}</strong></div>` : ''}<div><span>KDV</span><strong>${fmt(b.kdvTutar)}</strong></div><div class="tot"><span>Genel toplam</span><strong>${fmt(b.toplam)}</strong></div>`;
  if (my !== gen) return;
  kok().innerHTML = `<div class="card"><div class="head"><div><h2>${BELGE_AD[b.tur]} · <span class="mono">${esc(b.no)}</span> ${b.durum === 'iptal' ? '<span class="pill bad">İptal</span>' : ''}</h2>`+
    `<p class="sub">${esc(b.cariAd)} · ${tarih(b.tarih)}${b.vade ? ' · vade ' + tarih(b.vade) : ''}${b.haricNo ? ' · harici no ' + esc(b.haricNo) : ''} · ${esc(b.user.name)}</p></div>`+
    `<div class="row"><button class="btn" data-fa="belge-yazdir">Yazdır</button>${b.durum === 'acik' ? `<button class="btn danger" data-fa="belge-iptal" data-id="${esc(b.id)}">${silOnay === 'belge' ? 'Emin misiniz? Tekrar tıklayın' : 'İptal et'}</button>` : ''}<button class="btn" data-fa="belge-geri">Listeye dön</button></div></div>`+
    `<div class="tw"><table><thead><tr><th>Kalem</th><th class="num">Adet</th><th class="num">Birim fiyat</th><th class="num">KDV</th><th class="num">Tutar</th></tr></thead><tbody>${satirlar}</tbody></table></div>`+
    `<p class="sub">${b.kdvDahil ? 'Birim fiyatlar KDV dahildir.' : 'Birim fiyatlar KDV hariçtir.'}${b.stokIslem ? ' Stok hareketi işlendi.' : ' Stoğa işlenmedi.'}${b.notlar ? ' Not: ' + esc(b.notlar) : ''}</p>`+
    `<div class="sum" style="margin-top:12px">${toplamlar}</div></div>`;
  kok().dataset.belge = JSON.stringify(b);
}
function belgeYazdir() {
  const b = JSON.parse(kok().dataset.belge || '{}');
  const s = (b.satirlar || []).map((x) => `<tr><td>${esc(x.ad)}</td><td class="num">${x.adet}</td><td class="num">${fmt(x.fiyat)}</td><td class="num">%${x.kdv}</td><td class="num">${fmt(x.adet * x.fiyat)}</td></tr>`).join('');
  yazdir(b.no, `<div class="top"><div><h1>RO-STAR</h1><div class="muted">${esc(BELGE_AD[b.tur])}${b.durum === 'iptal' ? ' (İPTAL)' : ''}</div></div><div style="text-align:right"><strong>${esc(b.no)}</strong><br>${tarih(b.tarih)}${b.vade ? '<br>Vade: ' + tarih(b.vade) : ''}</div></div>`+
    `<h2>${esc(b.cariAd)}</h2><table><thead><tr><th>Kalem</th><th class="num">Adet</th><th class="num">Birim fiyat</th><th class="num">KDV</th><th class="num">Tutar</th></tr></thead><tbody>${s}</tbody></table>`+
    `<table class="tot"><tr><td>Ara toplam</td><td class="num">${fmt(b.ara)}</td></tr>${b.iskontoTutar ? `<tr><td>İskonto</td><td class="num">− ${fmt(b.iskontoTutar)}</td></tr>` : ''}<tr><td>KDV</td><td class="num">${fmt(b.kdvTutar)}</td></tr><tr><td><strong>Genel toplam</strong></td><td class="num"><strong>${fmt(b.toplam)}</strong></td></tr></table>`+
    `<p class="muted">${b.kdvDahil ? 'Birim fiyatlar KDV dahildir.' : 'Birim fiyatlar KDV hariçtir.'} Bu belge resmi e-fatura yerine geçmez.</p>`);
}

/* ======================= FİYAT LİSTELERİ ======================= */
function listeCiz() {
  kok().innerHTML =
    (listeForm ? `<div class="card"><div class="head"><h2>${listeForm.id ? 'Listeyi düzenle' : 'Yeni fiyat listesi'}</h2></div><div class="formgrid">`+
      `<label class="f">Liste adı<input id="lf-ad" value="${esc(listeForm.ad || '')}" placeholder="Örn. Bayi, Apartman yönetimi"></label>`+
      `<label class="f">Baz fiyat<select id="lf-kaynak">${secenekler(KAYNAK_AD, listeForm.kaynak || 'toptan')}</select></label>`+
      `<label class="f">Yüzde fark (%) <span style="font-weight:400">− indirim, + zam</span><input id="lf-yuzde" type="number" step="0.5" value="${listeForm.yuzde || 0}"></label>`+
      `<label class="f" style="grid-column:1/-1">Ürüne özel fiyatlar (her satıra <span class="mono">barkod=fiyat</span>, boş bırakılabilir)<textarea id="lf-ozel" placeholder="8690001=330&#10;8690002=45,50">${esc(Object.keys(listeForm.ozel || {}).map((k) => `${k}=${listeForm.ozel[k]}`).join('\n'))}</textarea></label></div>`+
      `<div class="row" style="margin-top:14px"><button class="btn primary" data-fa="liste-kaydet">Kaydet</button><button class="btn" data-fa="liste-vazgec">Vazgeç</button>${listeForm.id ? `<button class="btn danger" data-fa="liste-sil">${silOnay === 'liste' ? 'Emin misiniz? Tekrar tıklayın' : 'Sil'}</button>` : ''}</div></div>` : '')+
    `<div class="card"><div class="head"><div><h2>Fiyat listeleri</h2><p class="sub">Bir listeyi cariye bağlayınca, o cariye fatura keserken fiyatlar otomatik gelir. Ürüne özel fiyat, yüzde farkından önceliklidir.</p></div><button class="btn primary" data-fa="liste-yeni">Yeni liste</button></div>`+
      `<div class="tw"><table><thead><tr><th>Liste</th><th>Baz fiyat</th><th class="num">Fark</th><th class="num">Özel fiyatlı ürün</th><th></th></tr></thead><tbody>`+
      (L.length ? L.map((x) => `<tr><td>${esc(x.ad)}</td><td>${KAYNAK_AD[x.kaynak]}</td><td class="num">${x.yuzde > 0 ? '+' : ''}${x.yuzde}%</td><td class="num">${Object.keys(x.ozel || {}).length}</td><td class="num"><button class="btn sm" data-fa="liste-duzenle" data-id="${esc(x.id)}">Düzenle</button></td></tr>`).join('')
        : '<tr><td colspan="5" class="empty">Henüz fiyat listesi yok. Cariler standart perakende fiyatını görür.</td></tr>')+
      `</tbody></table></div></div>`;
}
async function listeKaydet() {
  const ozel = {};
  $('#lf-ozel').value.split(/\r?\n/).forEach((s) => {
    const m = s.split('='); if (m.length !== 2) return;
    const f = parseNum(m[1]); if (m[0].trim() && !isNaN(f)) ozel[m[0].trim()] = f;
  });
  const o = { ad: $('#lf-ad').value, kaynak: $('#lf-kaynak').value, yuzde: parseNum($('#lf-yuzde').value) || 0, ozel };
  try {
    await api(listeForm.id ? 'fiyat-listeleri/' + encodeURIComponent(listeForm.id) : 'fiyat-listeleri', { method: listeForm.id ? 'PUT' : 'POST', body: o });
    listeForm = null; toast('Liste kaydedildi'); render();
  } catch (e) { toast(e.message, 'bad'); }
}

/* ======================= YEDEK ======================= */
async function yedekCiz() {
  const my = gen;
  const liste = await api('backup');
  if (my !== gen) return;
  kok().innerHTML = `<div class="card"><div class="head"><div><h2>Yedekleme</h2><p class="sub">Sistem her gün sabah 04:00'te otomatik yedek alır ve son 14 yedeği saklar. Şifre bilgileri yedeğe girmez.</p></div>`+
    `<div class="row"><button class="btn primary" data-fa="yedek-al">Şimdi yedek al</button><button class="btn" data-fa="yedek-indir-canli">Tüm veriyi indir (JSON)</button></div></div>`+
    `<div class="tw"><table><thead><tr><th>Tarih</th><th>Alındığı saat</th><th class="num">Veri grubu</th><th></th></tr></thead><tbody>`+
    (liste.length ? liste.map((x) => `<tr><td>${tarih(x.tarih)}</td><td>${new Date(x.olusturma).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}</td><td class="num">${x.anahtar}</td><td class="num"><button class="btn sm" data-fa="yedek-indir" data-t="${esc(x.tarih)}">İndir</button></td></tr>`).join('')
      : '<tr><td colspan="4" class="empty">Henüz yedek yok. İlk otomatik yedek bu gece alınır, isterseniz hemen alabilirsiniz.</td></tr>')+
    `</tbody></table></div></div>`;
}
async function indir(yol, ad) {
  const d = await api(yol);
  const blob = new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = ad;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* ======================= OLAYLAR ======================= */
document.addEventListener('click', async (e) => {
  const a = e.target.closest('[data-fa]'); if (!a || !kok() || !kok().contains(a)) return;
  e.preventDefault();
  const act = a.dataset.fa, id = a.dataset.id;
  const iki = (anahtar) => { if (silOnay !== anahtar) { silOnay = anahtar; render(); setTimeout(() => { if (silOnay === anahtar) { silOnay = null; render(); } }, 4000); return false; } silOnay = null; return true; };
  try {
    if (act === 'cari-yeni') { cariForm = { tur: 'musteri', aktif: true }; odemeCari = null; cariCiz(); }
    else if (act === 'cari-duzenle') { cariForm = { ...C.find((x) => x.id === id) }; odemeCari = null; cariCiz(); }
    else if (act === 'cari-vazgec') { cariForm = null; silOnay = null; cariCiz(); }
    else if (act === 'cari-kaydet') cariKaydet();
    else if (act === 'cari-sil') { if (iki('cari')) { await api('cariler/' + encodeURIComponent(cariForm.id), { method: 'DELETE' }); cariForm = null; toast('Cari silindi'); render(); } }
    else if (act === 'cari-detay') { ekstre = id; await render(); }
    else if (act === 'cari-satis') {
      const c = C.find((x) => x.id === id) || {};
      ekstre = null; belgeYeni();
      bf.cari = id; bf.iskonto = c.iskonto || 0; bf.vade = vadeHesapla(bf.tarih, c.vadeGun);
      AD.muGit('belge');
    }
    else if (act === 'cari-tahsilat') { const x = C.find((c) => c.id === id); odemeCari = { id, tur: x && x.bakiye < 0 ? 'odeme' : 'tahsilat' }; cariForm = null; ekstre = null; await render(); }
    else if (act === 'ekstre-duzenle') { cariForm = { ...C.find((x) => x.id === id) }; odemeCari = null; ekstre = null; await render(); }
    else if (act === 'detay-belge') { ekstre = null; belgeDetay = id; AD.muGit('belge'); }
    else if (act === 'ekstre-kapat') { ekstre = null; await render(); }
    else if (act === 'ekstre-yazdir') ekstreYazdir();
    else if (act === 'cari-odeme') { const x = C.find((c) => c.id === id); odemeCari = { id, tur: x && x.bakiye < 0 ? 'odeme' : 'tahsilat' }; cariForm = null; cariCiz(); }
    else if (act === 'odeme-vazgec') { odemeCari = null; cariCiz(); }
    else if (act === 'odeme-kaydet') {
      await api('odemeler', { method: 'POST', body: { tur: $('#of-tur').value, cari: odemeCari.id, hesap: $('#of-hesap').value, tutar: parseNum($('#of-tutar').value) || 0, tarih: $('#of-tarih').value, aciklama: $('#of-aciklama').value } });
      odemeCari = null; toast('Kaydedildi'); render();
    }
    else if (act === 'odeme-sil') { await api('odemeler/' + encodeURIComponent(id), { method: 'DELETE' }); toast('Kayıt silindi'); await render(); }
    else if (act === 'hesap-yeni') { hesapForm = true; hesapCiz(); }
    else if (act === 'hesap-vazgec') { hesapForm = false; hesapCiz(); }
    else if (act === 'hesap-kaydet') {
      await api('hesaplar', { method: 'POST', body: { ad: $('#hf-ad').value, tur: $('#hf-tur').value, acilis: parseNum($('#hf-acilis').value) || 0 } });
      hesapForm = false; toast('Hesap eklendi'); render();
    }
    else if (act === 'hesap-pasif') { const h = H.find((x) => x.id === id); await api('hesaplar/' + encodeURIComponent(id), { method: 'PUT', body: { aktif: !h.aktif } }); render(); }
    else if (act === 'hesap-hareket') { hesapHareket = id; hesapCiz(); }
    else if (act === 'hareket-kapat') { hesapHareket = null; hesapCiz(); }
    else if (act === 'hesap-duzeltme') { duzeltmeId = id; hesapCiz(); }
    else if (act === 'duzeltme-vazgec') { duzeltmeId = null; hesapCiz(); }
    else if (act === 'duzeltme-kaydet') {
      await api(`hesaplar/${duzeltmeId}/duzeltme`, { method: 'POST', body: { tutar: parseNum($('#du-tutar').value), aciklama: $('#du-neden').value } });
      duzeltmeId = null; toast('Bakiye düzeltildi'); render();
    }
    else if (act === 'transfer') {
      await api('hesaplar/transfer', { method: 'POST', body: { kaynak: $('#tf-kaynak').value, hedef: $('#tf-hedef').value, tutar: parseNum($('#tf-tutar').value) || 0 } });
      toast('Transfer yapıldı'); render();
    }
    else if (act === 'belge-yeni') belgeYeni();
    else if (act === 'belge-vazgec') { bf = null; belgeCiz(); }
    else if (act === 'kalem-ekle') { bf.kalemler.push({ barkod: '', ad: '', adet: 1, fiyat: 0, kdv: 20 }); kalemleriCiz(); toplamGuncelle(); }
    else if (act === 'kalem-sil') { if (bf.kalemler.length > 1) bf.kalemler.splice(+a.dataset.i, 1); kalemleriCiz(); toplamGuncelle(); }
    else if (act === 'belge-kaydet') belgeKaydet();
    else if (act === 'belge-ac') { belgeDetay = id; belgeCiz(); }
    else if (act === 'belge-geri') { belgeDetay = null; silOnay = null; belgeCiz(); }
    else if (act === 'belge-yazdir') belgeYazdir();
    else if (act === 'belge-iptal') {
      if (iki('belge')) {
        await api(`belgeler/${encodeURIComponent(id)}/iptal`, { method: 'POST' });
        toast('Belge iptal edildi, stok geri alındı'); if (AD.urunleriYenile) await AD.urunleriYenile(); belgeCiz();
      }
    }
    else if (act === 'liste-yeni') { listeForm = { kaynak: 'toptan', yuzde: 0, ozel: {} }; listeCiz(); }
    else if (act === 'liste-duzenle') { listeForm = { ...L.find((x) => x.id === id) }; listeCiz(); }
    else if (act === 'liste-vazgec') { listeForm = null; silOnay = null; listeCiz(); }
    else if (act === 'liste-kaydet') listeKaydet();
    else if (act === 'liste-sil') { if (iki('liste')) { await api('fiyat-listeleri/' + encodeURIComponent(listeForm.id), { method: 'DELETE' }); listeForm = null; toast('Liste silindi'); render(); } }
    else if (act === 'yedek-al') { await api('backup/run', { method: 'POST' }); toast('Yedek alındı'); render(); }
    else if (act === 'yedek-indir') indir('backup/' + encodeURIComponent(a.dataset.t), `yedek-${a.dataset.t}.json`);
    else if (act === 'yedek-indir-canli') indir('backup/export', `ro-star-veri-${bugun()}.json`);
  } catch (x) { toast(x.message, 'bad'); }
});

document.addEventListener('input', (e) => {
  const t = e.target; if (!kok() || !kok().contains(t)) return;
  if (t.id === 'fa-cariAra') { cariAra = t.value; const p = t.selectionStart; cariCiz(); const n = $('#fa-cariAra'); n.focus(); n.setSelectionRange(p, p); }
  else if (t.dataset.k && bf) {
    const [i, alan] = t.dataset.k.split(':');
    if (alan === 'ad') { /* seçim 'change' olayında işlenir */ bf.kalemler[+i].ad = t.value; bf.kalemler[+i].barkod = ''; }
    else bf.kalemler[+i][alan] = parseNum(t.value) || 0;
    toplamGuncelle();
  }
  else if (t.id === 'bd-iskonto' && bf) { bf.iskonto = Math.min(100, Math.max(0, parseNum(t.value) || 0)); toplamGuncelle(); }
  else if (bf && ['bd-haricNo', 'bd-notlar', 'bd-odenen'].includes(t.id)) { bf[{ 'bd-haricNo': 'haricNo', 'bd-notlar': 'notlar', 'bd-odenen': 'odenen' }[t.id]] = t.value; }
});
document.addEventListener('change', async (e) => {
  const t = e.target; if (!kok() || !kok().contains(t)) return;
  try {
    if (t.dataset.k && bf) {
      const [i, alan] = t.dataset.k.split(':');
      if (alan === 'ad') { kalemUrunSec(+i, t.value); kalemleriCiz(); toplamGuncelle(); }
    }
    else if (t.id === 'bd-tur' && bf) {
      bf.tur = t.value; bf.kdvDahil = bf.tur !== 'alis'; bf.stokIslem = bf.tur !== 'irsaliye'; bf.cari = ''; belgeFormCiz();
    }
    else if (t.id === 'bd-cari' && bf) {
      bf.cari = t.value; const c = C.find((x) => x.id === bf.cari);
      if (c && bf.tur === 'satis') { bf.iskonto = c.iskonto || 0; bf.vade = vadeHesapla(bf.tarih, c.vadeGun); bf.kalemler.forEach((k) => { if (k.barkod) kalemUrunSec(bf.kalemler.indexOf(k), k.barkod); }); belgeFormCiz(); }
    }
    else if (t.id === 'bd-tarih' && bf) { bf.tarih = t.value; const c = C.find((x) => x.id === bf.cari); if (c && c.vadeGun && bf.tur === 'satis') { bf.vade = vadeHesapla(bf.tarih, c.vadeGun); const v = $('#bd-vade'); if (v) v.value = bf.vade; } }
    else if (t.id === 'bd-vade' && bf) bf.vade = t.value;
    else if (t.id === 'bd-hesap' && bf) bf.hesap = t.value;
    else if (t.id === 'bd-kdvDahil' && bf) { bf.kdvDahil = t.checked; toplamGuncelle(); }
    else if (t.id === 'bd-stok' && bf) bf.stokIslem = t.checked;
    else if (t.id === 'bd-alisGuncelle' && bf) bf.alisGuncelle = t.checked;
    else if (t.id === 'bl-ay') { belgeFiltre.ay = t.value || ayAnahtar(); belgeCiz(); }
    else if (t.id === 'bl-tur') { belgeFiltre.tur = t.value; belgeCiz(); }
    else if (t.id === 'tf-satisHesap') { await api('settings', { method: 'PUT', body: { satisHesap: t.value || null } }); toast('Kaydedildi'); }
  } catch (x) { toast(x.message, 'bad'); }
});

window.FIN = { render, sifirla() { ekstre = cariForm = odemeCari = hesapHareket = duzeltmeId = belgeDetay = bf = listeForm = null; hesapForm = false; silOnay = null; } };
})();
