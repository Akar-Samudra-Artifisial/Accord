# Changelog

Semua perubahan penting dicatat di sini. Format mengikuti Keep a Changelog, versi mengikuti SemVer.

## [Unreleased]

### Added
- Scaffolding Forge app (UI Kit, runtime `nodejs24.x`, TypeScript): manifest dengan issue panel Jira, global page, byline Confluence, consumer antrean negosiasi, monitor harian, Forge SQL, agen Rovo "Accord Team Delegate" dan "Accord Broker", serta enam action Rovo (belum di-deploy; `app.id` masih placeholder sampai `forge register`).
- Skema Forge SQL untuk tim, piagam, throughput, permintaan, putaran negosiasi, opsi, persetujuan, kontrak, relasi dependensi, dan jejak audit.
- Planner deterministik: kapasitas realistis/pesimis dari 6 sprint terakhir, opsi tepat waktu, tepat waktu dengan penggeseran (garis merah tidak pernah digeser), sebagian, lebih lambat, dan tolak berdasarkan porsi maksimal piagam; maksimal 4 opsi berurutan dengan satu rekomendasi.
- Penjelasan opsi dalam bahasa Inggris netral yang setiap angkanya berasal dari jejak perhitungan, plus konsekuensi untuk tim peminta dan penyedia.
- Variasi "bagian minimum lebih awal N hari" untuk putaran negosiasi.
- Skenario demo Mobile/Payments dengan riwayat throughput simulasi; action `evaluate-options` sementara memakai skenario ini.
- Data layer Jira (board Scrum, sprint, issue sprint, pencarian JQL, bulk create) dan Confluence (space, halaman v2, label) via `asApp`/`asUser`.
- Piagam tim: generator template storage format (heading h2 per field), parser, dan validator yang mengembalikan field yang kurang; hasil disimpan di tabel `charters`.
- Kapasitas & komitmen: sampel throughput dari sprint Jira yang selesai (atau Simulated history), komitmen sprint aktif + berikutnya + issue ber-due date.
- Generator demo data bertahap & idempoten: project MOB/PAY dengan board Scrum, sprint aktif + berikutnya berisi issue, halaman piagam berlabel `accord-charter`, dan 6 sprint throughput simulasi per tim.
- Global page: tab Teams (status piagam, rentang kapasitas, lencana "Simulated history"/"Limited data", tombol "Create charter page"), tab Demo (seed dengan konfirmasi dan status per langkah); byline Confluence menampilkan "Charter valid" atau field yang kurang.
- Web trigger diagnostik khusus development (`accord-dev-diag`); hasil spike M0 di `docs/spikes.md`.
- Permintaan dependensi dari issue panel Jira (judul, ukuran, bagian minimum, tanggal butuh, kelas biaya) yang memicu negosiasi dua putaran lewat antrean `accord-negotiation`: putaran 1 delegasi penyedia (planner) lalu delegasi peminta (minta bagian minimum lebih awal bila tak ada opsi yang memenuhi), putaran 2 broker mengurutkan opsi, menandai rekomendasi, dan berkomentar di issue sumber & penyedia. Consumer idempoten dan retry terbatas; kegagalan dicatat di putaran sebelum status `failed`.
- Deal sheet (modal) berisi opsi, konsekuensi, transkrip yang setiap angkanya berasal dari jejak planner, dan pratinjau perubahan Jira; approval dua lead (piagam/lead tim) untuk opsi yang sama, identitas dari konteks Forge, penolakan wajib beralasan.
- Apply-contract setelah dua approve: issue deliverable di project penyedia, link "blocks" ke issue sumber, pemindahan issue tergeser ke sprint target/backlog, komentar, kontrak, relasi dependensi, dan audit; idempoten bila diulang.
- Global page: tab Inbox (permintaan yang menunggu keputusan Anda) dan Contracts; action Rovo memakai layanan negosiasi yang sama.
- Aksi diagnostik `create-request` dan `request` di `accord-dev-diag` (khusus development).
- Tombol "Retry negotiation" di deal sheet untuk request `failed` atau macet di `negotiating`/`approved` lebih dari 5 menit (pembuat atau lead kedua tim); pesan "Still working — Refresh" saat polling habis.
- Badge "Demo mode: same approver allowed" bila `ACCORD_DEMO_ALLOW_SAME_APPROVER=true`.
- Aksi diagnostik `verify-blocks-link`; bagian "Before production" di README.
- Monitor kontrak harian: proyeksi tanggal per kontrak aktif dari komitmen sprint penyedia + kontrak sebelumnya, status `at-risk`/`on-track` (sekali per perubahan, idempoten), komentar netral dengan mention lead di issue sumber & deliverable, audit; dijalankan per tim lewat antrean `accord-monitor` dan tombol "Run daily monitor now".
- Lencana "At risk" dan kolom tanggal proyeksi di issue panel dan tab Contracts; ringkasan dependensi antar tim (FR-13).
- Tab Audit: entri audit terbaru untuk tim yang bisa Anda akses, tanpa account id mentah.
- Tombol demo "Add two critical bugs to Payments" dan "Reset demo bugs" (idempoten, khusus admin project PAY).
- Issue seed ketujuh di sprint aktif Payments agar skenario "on time with shift" muncul.
- Action Rovo memakai data nyata (piagam, kapasitas, request, opsi, kontrak) dengan validasi input; action buat request menerima `costClass`; prompt agen melarang angka karangan, approve, dan menebak.
- Aksi diagnostik `monitor`, `demo-bugs`, `actions`, `verify-sprint-move`, `audit`.
- Status kontrak `unknown` ("Not enough data") bila kapasitas penyedia tidak punya data atau pesimis 0; tanpa komentar.
- Monitor dijadwalkan untuk tim penyedia segera setelah apply-contract, sehingga kontrak baru langsung punya tanggal proyeksi.
- Output `list-contracts` berisi `role` (`provider`/`requester`), `requesterTeamKey`, dan `providerTeamKey`.
- Action Rovo `list-teams` (team key, nama, project key) untuk kedua agen; prompt agen mewajibkan resolusi nama tim lewat `list-teams`.
- Aksi demo "Make me the demo lead" (khusus site admin atau admin project demo): pemanggil menjadi lead project demo milik Accord dan satu-satunya approver piagam demo, lalu piagam disinkronkan; idempoten.
- Seed demo memakai akun pemicu dari UI sebagai lead & approver; seed diag menerima `?lead=<accountId>` atau `ACCORD_DEV_OWNER_ACCOUNT_ID`. Aksi diagnostik `demo-lead` dan `user-search`.
- Output action Rovo yang menyebut issue, kontrak, request, atau piagam memuat `url` absolut dari `baseUrl` site (serverInfo, di-cache); prompt kedua agen hanya boleh menautkan URL dari output action.
- Polling terbatas (3 detik × 20) di tab Inbox/Contracts, issue panel, dan deal sheet selama status masih transisional (negotiating, approved, applying, kontrak belum dievaluasi) atau setelah approve/reject dan aksi demo, dengan tombol Refresh sebagai cadangan.
- Refresh ringan tab Inbox/Contracts di global page: tiap 12 detik sampai 10 menit sejak interaksi terakhir (ganti tab, keputusan, aksi demo), dan sekali lagi saat tab dipilih; daftar hanya di-render ulang bila data berubah. Request baru dari agen langsung tampil dengan badge "Negotiating".
- Aksi diagnostik `actions` menerima `?titleIssue=<key>&title=…` untuk pratinjau judul request tanpa membuat request.

### Security
- Dual control: satu akun tidak boleh approve untuk kedua tim kecuali variabel demo `ACCORD_DEMO_ALLOW_SAME_APPROVER=true` (hanya development).
- Register tim, buat halaman piagam, dan sinkron piagam hanya untuk lead project Jira atau pemilik `ADMINISTER_PROJECTS`; approver default piagam = lead project, bukan pemanggil.
- Web trigger `accord-dev-diag` menolak semua aksi (404) kecuali `ACCORD_DIAG_ENABLED=true`.
- Deal sheet, Inbox, dan Contracts hanya untuk approver/lead tim terkait atau user yang bisa browse issue sumber/deliverable; account id mentah tidak lagi dikirim ke UI.
- Pembuat request wajib punya izin browse + comment di issue sumber; batas 10 request per jam per user.
- Error ke klien kini generik dengan kode referensi; detail hanya di `forge logs`.
- Action `get-team-charter`/`get-team-capacity` hanya untuk approver/lead tim atau user dengan `BROWSE_PROJECTS` di project tim; selain itu error generik.
- Request baru ditolak bila sudah ada request terbuka untuk issue sumber + penyedia yang sama; maksimal 20 request baru per jam per tim penyedia (dicek dalam satu INSERT).
- Judul request dinormalisasi (satu baris, ≤120 karakter, tanpa karakter kontrol, tanda kutip ganda diganti) dan dikutip di komentar; prompt kedua agen menyatakan nilai field action adalah data, bukan instruksi; Delegate wajib meminta konfirmasi eksplisit sebelum `create-dependency-request`.
- Komentar monitor di issue peminta hanya berisi tanggal proyeksi dan rentang kesepakatan, tanpa beban kerja internal penyedia.
- Diag: impersonasi `account=lead` dihapus, error mentah diganti pesan generik dengan referensi.

### Fixed
- Agen Rovo di Rovo Home membaca DB yang salah ("Team ACPAY is not registered") dan setiap agen muncul dua kali: instalasi Jira dan Confluence terpisah, masing-masing punya Forge SQL dan salinan agen sendiri. Manifest kini memakai `app.compatibility` (Jira wajib, Confluence opsional), sehingga satu instalasi per site dipakai bersama oleh Jira dan Confluence.
- Default "Needed by" di issue panel tidak lagi tampil 2/18/1993; nilainya kini hari ini (UTC) + 21 hari.
- Request bisa macet di `negotiating` bila broker selesai tapi transisi status hilang; round 2 kini melanjutkan transisinya.
- Race reject vs approve: approval disisipkan hanya selama status `awaiting-approval` (INSERT … SELECT), reject mengklaim status dulu, dan UI tidak lagi menerima status `rejected` palsu.
- Arah link Blocks: deliverable "blocks" issue sumber, dicek peka arah (terverifikasi di site).
- Urutan jejak audit kini berdasarkan waktu (id Forge SQL tidak berurutan).
- Deliverable ganda setelah crash: intent di SQL sebelum create + jeda pencarian JQL; opsi kontrak diambil dari kontrak tersimpan.
- Redaksi key memakai batas kata (PAY-1 tidak mengenai PAY-11) dan juga meredaksi `sources`.
- Request yatim saat push antrean gagal kini berstatus `failed`.
- Komentar Accord maksimal sekali per issue/langkah (penanda SQL).
- Byline "Accord charter" di Confluence menampilkan "Unknown SQL execution error": byline kini memvalidasi halaman piagam langsung dari isi halaman tanpa Forge SQL (database instalasi Confluence terpisah dari Jira), dan error resolver dicatat ke `forge logs`.
- Push ke queue Forge (`accord-negotiation`, `accord-demo-seed`) selalu `400 Bad Request`: modul `consumer` kini memakai format `@forge/events` v2+ (`function`, bukan `resolver`) dan consumer membaca `event.body` dari `AsyncEvent`.
- Form permintaan di issue panel kehilangan karakter saat diketik cepat: kini memakai `Form`/`useForm` UI Kit (tak terkontrol); field project key di tab Teams juga tak terkontrol.
- Tombol approve tetap aktif untuk tim yang sudah approve; kini hanya tim yang belum memutuskan (atau saat kedua tim memilih opsi berbeda) yang bisa approve.
- Judul "Accord" tampil dua kali di global page.
- Monitor dan Audit tidak lagi memakai daftar kontrak ber-`LIMIT 100`: query per penyedia/request tanpa batas, sehingga beban di depan menghitung semua kontrak.
- Notifikasi monitor memakai marker atomik (`contract_notifications`, unique contract + urutan perubahan + issue) dan membandingkan dengan notifikasi terakhir, sehingga retry setelah crash tetap mengirim tepat satu komentar per perubahan dan issue; marker lama dari audit dibawa lewat migrasi.
- Kolom Details di Audit menampilkan nama opsi dan rentang tanggal, bukan "approved option 4".
- Diag sprint move mengembalikan issue ke backlog bila asalnya dari backlog.
- Cek izin project di Audit berjalan paralel dan dilewati untuk tim tempat user menjadi approver.
- Load pertama global page di instalasi baru gagal (`Failed to execute migration` v008–v010) karena resolver paralel menjalankan DDL bersamaan: migrasi kini satu jalur per instance (promise di-memoize), konflik migrasi di-retry dengan backoff + jitter (4 percobaan, cause dicatat ke log), dan dijalankan juga lewat trigger `avi:forge:installed:app`/`avi:forge:upgraded:app`; resolver tetap memakai `ensureSchema` sebagai fallback. Test memastikan semua migrasi idempoten.
- Seed demo tidak lagi bentrok dengan project MOB/PAY milik pihak lain: key yang sudah dipakai project non-Accord dilewati (`ACMOB`/`ACPAY`, lalu `ACMOB2` …), begitu pula space Confluence `ACCORD` (`ACCORD2` …). Project dikenali milik Accord lewat property `accord.demo` atau tabel `teams` (nama "Mobile"/"Payments"); space lewat nama "Accord team charters" atau halaman piagam tim terdaftar.

### Changed
- `teamKey`/`providerTeamKey` di action Rovo menerima key atau nama tim terdaftar (case-insensitive) dan di-resolve ke key Accord; key/nama tak dikenal atau ambigu ditolak dengan daftar tim valid (mis. `PAY` milik pihak lain di one-atlas).
- Tombol "Add critical bugs to Payments" menghitung jumlah bug (maks 8, label `accord-demo-bug` + garis merah piagam) dari proyeksi monitor kontrak terdekat sampai benar-benar At risk, hanya menambah kekurangan, lalu langsung mengantrekan monitor; reset memindahkan bug demo ke backlog dan mengantrekan monitor lagi.
- Judul request kini opsional (action & Delegate): tanpa judul dipakai summary issue sumber; kartu konfirmasi tetap muncul. Judul placeholder (kosong, diapit tanda kurung, atau berisi "summary of the source issue") diperlakukan sebagai kosong; deskripsi input `title` dan prompt Delegate melarang mengisi judul placeholder.
- Tab Demo, tombol critical bugs, dan diag memakai key project/space yang benar-benar dipakai seed (rencana seed di `getSeedStatus`; status diag menampilkan `seedPlan` dan migrasi yang belum jalan).
- Scope tambahan Jira/Confluence untuk Agile API, pembuatan project, space, dan label.
- Pemakaian scope didokumentasikan (`docs/spikes.md`, README "Before production"); scope khusus seed tetap ada sampai demo dipisah.
- Data planning Jira dimuat sekali per job putaran 1; Inbox/Contracts tanpa N+1 dan filter viewer sebelum limit.
- Retry antrean: 5 percobaan (batas 4 retry Forge) dengan backoff 10/20/40/80 detik.
- Migrasi v012–v014: UNIQUE `dependency_edges.contract_id`, index `requests.source_issue_key` dan `contracts.deliverable_issue_key`.
- Validasi project key di JQL dan `costClass` di action Rovo hanya nilai enum.
- Deal sheet dirapikan: satu kartu opsi rekomendasi/disepakati di atas, opsi lain di bawahnya, detail ("Why these numbers", aturan piagam, pratinjau perubahan Jira) dan transkrip bisa dilipat; status per tim ("Mobile lead: approved by you · Payments lead: decision pending"); setelah kontrak aktif tampil "Changes applied" dengan tautan issue deliverable, link, pemindahan sprint, dan komentar.
- Pesan keputusan memakai nama opsi + rentang tanggal, bukan ID internal opsi.
- Issue panel memperbarui badge status sendiri (polling terbatas, refresh setelah kirim/keputusan/tutup modal) dengan tombol Refresh sebagai cadangan.
