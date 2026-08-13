# Nexoria Discord Event Bot

Albion Online ve benzeri MMO etkinlikleri için şablon tabanlı grup kurma botu. Etkinlikler artık harici bir veritabanına ihtiyaç duymadan, bot sunucusundaki kalıcı SQLite dosyasında tutulur.

## Özellikler

- Basit veya kategorili rol şablonlarından etkinlik oluşturma
- Rol seçme, rolden ayrılma ve doluluk göstergesi
- Lider için etkinliği düzenleme, grubu etiketleme ve etkinliği kapatma kontrolleri
- Kullanıcı başına en fazla 5 aktif etkinlik
- 72 saatten eski etkinlikleri otomatik temizleme
- Aynı etkinlikteki eşzamanlı işlemleri sıraya alarak slot çakışmalarını önleme
- Yerel SQLite, WAL journal ve tam senkronizasyon ile kalıcı ve atomik yazma

## Yerel kurulum

Node.js 22.22 veya daha yeni bir sürüm gerekir. Sunucuda Node.js 24 LTS önerilir.

```bash
npm install
```

`.env.example` dosyasını `.env` adıyla kopyalayıp doldurun:

```dotenv
DISCORD_TOKEN=PRODUCTION_BOT_TOKEN
CLIENT_ID=PRODUCTION_APPLICATION_ID
DATABASE_PATH=data/nexoria.sqlite
DISCORD_DEBUG=false
ALLOWED_GUILDS=
```

`DISCORD_TOKEN` ve `CLIENT_ID` aynı Discord uygulamasına ait olmalıdır. `ALLOWED_GUILDS` boş bırakılırsa bot davet edildiği her sunucuda çalışır; sınırlandırmak için sunucu ID'lerini virgülle ayırın.

Botu başlatın:

```bash
npm start
```

Başarılı açılışta buna benzer satırlar görülür:

```text
[EventStore] SQLite ready (.../data/nexoria.sqlite).
[Startup] Node v24.x, discord.js 14.27.0, SQLite events: 0
Discord Gateway bağlantısı başlatılıyor...
Discord bağlantısı hazır! Giriş yapan hesap: Nexoria
```

## Veri güvenliği

SQLite dosyası varsayılan olarak `data/nexoria.sqlite` konumundadır. Uygulama şu güvenlik ayarlarını otomatik uygular:

- `journal_mode=WAL`: ani kapanmalarda yarım yazma riskini azaltır.
- `synchronous=FULL`: Discord'a başarı cevabı verilmeden önce verinin diske yazılmasını ister.
- `busy_timeout=5000`: kısa süreli dosya kilitlerinde hemen hata vermek yerine bekler.
- Hazır SQL ifadeleri ve JSON doğrulaması kullanılır.
- Normal kapanışta WAL ana veritabanı dosyasına checkpoint edilir.

Önemli noktalar:

- `data/` klasörü Git'e eklenmez. Bu klasör runtime verisidir.
- Bot çalışırken `nexoria.sqlite-wal` ve `nexoria.sqlite-shm` dosyalarının görünmesi normaldir.
- Panelden **Fresh Install/Reinstall** yapmadan önce botu durdurup `data/` klasörünü indirin. Fresh Install sunucu dosyalarını silebilir.
- Eski harici veritabanı kayıtları otomatik aktarılmaz. Taşıma öncesinde açık olan etkinlikleri kapatıp BisectHosting sürümünde yeniden oluşturun.

## BisectHosting kurulumu

### GitHub üzerinden önerilen yöntem

1. Bu değişiklikleri GitHub'daki `main` dalına gönderin.
2. BisectHosting **Starbase** panelinde sunucunuzu durdurun.
3. **Startup** sekmesindeki Git ayarlarında:
   - **Git Repo Address:** GitHub depo adresiniz
   - **Git Branch:** `main`
   - **Auto Update:** Açık
   - Özel depoysa **Git Username** ve yalnızca bu depoya erişen GitHub Personal Access Token girin.
4. **Main File** alanına `src/index.js` yazın.
5. Node.js sürümünü seçebiliyorsanız `24` veya en yeni `24.x LTS` sürümünü seçin.
6. **Additional Packages** alanını boş bırakın. Bağımlılıklar `package.json` üzerinden kurulur.
7. İlk kurulum için **Fresh Install** çalıştırın.
8. **Files** sekmesinde depo dosyalarının geldiğini doğrulayın ve kök dizinde `.env` oluşturun. Yalnızca production Discord botunun tokenını kullanın.
9. Sunucuyu başlatıp Console'da başarılı SQLite ve Discord bağlantı loglarını kontrol edin.

Alternatif olarak projeyi ZIP olarak yükleyebilirsiniz. `node_modules/`, `.git/`, `.env` ve `data/` klasörlerini ZIP'e koymayın; `.env` dosyasını panelde ayrıca oluşturun.

BisectHosting bot sunucusu sürekli çalışan bir process sunduğu için HTTP portu veya REST health endpoint'i gerekmez. Botun çevrimiçi kalmasını Discord Gateway bağlantısı sağlar.

## Güncelleme ve yedekleme

Normal kod güncellemesi:

1. Değişiklikleri GitHub'a gönderin.
2. BisectHosting panelinden botu yeniden başlatın.
3. Auto Update açıksa yeni kod çekilir; `data/` ve `.env` Git tarafından yönetilmediği için yerinde kalır.

Veritabanı yedeği almak için botu durdurun, **Files** sekmesinden tüm `data/` klasörünü indirin ve ardından botu yeniden başlatın. BisectHosting'in otomatik günlük yedekleri ek koruma sağlar; yine de büyük bir güncelleme veya Fresh Install öncesinde manuel kopya alın.

## Şablon örneği

```text
#Tanks
Mace > Astral aegis - Cleric cowl - Armor of valor
Heavy Mace > Hellion hood - Guardian armor

#Healers
Hallowfall > Mistcaller - Druid robe - Soldier helmet
Wild Staff > Mercenary hood - Cleric robe

#DPS
Light Crossbow > Cryptcandle - Royal cowl - Druid robe
Realmbreaker > Hellion jacket - Royal hood
Realmbreaker > Hellion jacket - Royal hood
```

Tokenları README'ye, GitHub'a, destek mesajlarına veya loglara yapıştırmayın.
