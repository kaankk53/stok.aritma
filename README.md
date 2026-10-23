# Arıtma Stok Paneli

Su arıtma işletmesi için stok yönetimi, barkodlu toptan/perakende satış, kâr hesabı ve personel yönetimi paneli.
Netlify üzerinde çalışır; ek bir veritabanı hesabı gerekmez (veriler Netlify Blobs'ta tutulur).

## İki ayrı panel

| Adres | Kim girer | Ne yapar |
|---|---|---|
| `/` | Personel | İşlerim (yapılacak / yaptığım işler), masraf girişi, stok sayımı ve düzeltme, barkodlu satış |
| `/admin` | Yönetici | Her şey: özet, stok + Excel yükleme, satış, iş dağılımı, kâr hesabı, pazaryerleri, personel yönetimi |

Girişler ayrıdır: yönetici hesabı personel paneline, personel hesabı yönetici paneline giremez.

| | Yönetici | Personel |
|---|---|---|
| İş oluşturma, personele atama, silme | Evet | Hayır |
| Kendine atanan işi başlatma / tamamlama, not, parça, masraf ekleme | Evet | Evet (tamamlanan işte parça/masraf değişmez) |
| İş maliyeti ve kârı (parça alışı + masraflar) | Görür | Görmez |
| Stok sayımı / düzeltme (sebep zorunlu, kayıt tutulur) | Evet | Evet |
| Alış fiyatı, marj, kâr raporları | Görür | Görmez |
| Muhasebe: gider defteri (maaş, kira, fatura, yakıt, vergi, reklam, stok alımı), aylık ve yıllık gelir-gider-net kâr | Evet | Hayır |
| Excel ile stok yükleme, ürün ekleme/silme | Evet | Hayır |
| Personel ekleme, şifre sıfırlama, pasifleştirme | Evet | Hayır |

Maliyet verisi personele hiç gönderilmez; gizleme sunucuda yapılır, yalnızca ekranda saklanmaz.

## Yayına alma (GitHub + Netlify)

### 1. GitHub'a yükleyin

GitHub'da boş bir depo açın (ör. `aritma-stok`), sonra bu klasörde:

```bash
git init
git add .
git commit -m "İlk sürüm"
git branch -M main
git remote add origin https://github.com/KULLANICI_ADINIZ/aritma-stok.git
git push -u origin main
```

Depoyu **Private** (özel) yapmanız önerilir.

### 2. Netlify'a bağlayın

1. Netlify'da **Add new site → Import an existing project → GitHub** deyin ve depoyu seçin.
2. Ayarlar `netlify.toml` dosyasından otomatik gelir (yayın klasörü `public`, build komutu yok). Olduğu gibi bırakın.
3. Deploy etmeden önce **Site configuration → Environment variables** bölümüne şunları ekleyin:

| Değişken | Değer |
|---|---|
| `JWT_SECRET` | En az 32 karakterlik rastgele bir metin. Oturum güvenliği için kullanılır. |
| `ADMIN_PASSWORD` | İlk yönetici hesabının şifresi (güçlü bir şifre seçin). |
| `ADMIN_USERNAME` | İsteğe bağlı. Boşsa `admin` olur. |

Rastgele `JWT_SECRET` üretmek için: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

4. **Deploy site** deyin.

### 3. İlk giriş

`https://siteniz.netlify.app/admin` adresinden kullanıcı adı `admin` (veya `ADMIN_USERNAME`) ve `ADMIN_PASSWORD` ile giriş yapın. İlk girişte yönetici hesabı veritabanına yazılır.
Sonra **Personel** sekmesinden (yönetici panelinde) personelinizi ekleyin. Giriş yaptıktan sonra `ADMIN_PASSWORD` değişkenini Netlify'dan silebilirsiniz; hesap zaten oluşmuştur ve şifresini panelden değiştirebilirsiniz.

### 4. Stoğu yükleyin

**Stok** sekmesinden Excel dosyanızı yükleyin. Sütunlar: `Barkod, Ürün Adı, Kategori, Alış Fiyatı, Perakende Fiyatı, Toptan Fiyatı, Stok, Kritik Stok`.
Toptan fiyatı boşsa alış fiyatına belirlediğiniz marj eklenir.

## Yerel çalıştırma

```bash
npm install
npm test                     # sunucu testleri
npx netlify-cli dev          # http://localhost:8888
```

Yerelde çalıştırmak için bir `.env` dosyası oluşturun (`.gitignore` içindedir, GitHub'a gitmez):

```
JWT_SECRET=en-az-32-karakterlik-rastgele-bir-metin
ADMIN_PASSWORD=gecici-bir-sifre
```

## Dosya yapısı

```
public/index.html            Personel paneli (/)
public/admin/index.html      Yönetici paneli (/admin)
public/assets/               Ortak stil ve ortak JS (barkodlu satış modülü)
netlify/functions/api.mjs    Netlify fonksiyonu, depolamayı Netlify Blobs'a bağlar
lib/handler.mjs              Tüm sunucu mantığı: giriş, roller, ürün, satış, ayarlar
test/api.test.mjs            Sunucu testleri
netlify.toml                 Netlify ayarları
```

## Bilmeniz gerekenler

- **Pazaryeri entegrasyonu henüz taslak.** Pazaryerleri sekmesi komisyon oranlarını kâr hesabına işler, ancak Trendyol, Hepsiburada gibi sitelere gerçek bağlantı kurmaz. Bu, ayrı bir geliştirme gerektirir (sunucuda pazaryeri API'lerini çağıran fonksiyonlar).
- **Ölçek.** Küçük bir işletme için (birkaç personel, birkaç bin ürün) tasarlandı. İki kişi aynı anda satış yaparsa nadiren stok yazımları çakışabilir. Yoğun kullanımda gerçek bir veritabanına (ör. Supabase) geçmek gerekir.
- **Stok yüklemesi** (Excel) stok hareketleri kaydına yazılmaz; sayım, düzeltme ve işte kullanılan parçalar yazılır.
- **Yedek yok.** Veriler yalnızca Netlify Blobs'ta durur. Ürünleri Excel'den yeniden yükleyebilirsiniz, ancak satış geçmişi için bir yedek özelliği henüz yok.
- **Giriş güvenliği.** Şifreler scrypt ile saklanır, oturum 12 saat geçerlidir, hatalı girişlerde yarım saniye bekletilir. Giriş denemesi sınırlaması (kilitleme) yoktur; güçlü şifreler kullanın.
- Excel okuma kütüphanesi ve yazı tipleri internetten (CDN) yüklenir.
