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

### Security
- Dual control: satu akun tidak boleh approve untuk kedua tim kecuali variabel demo `ACCORD_DEMO_ALLOW_SAME_APPROVER=true` (hanya development).
- Register tim, buat halaman piagam, dan sinkron piagam hanya untuk lead project Jira atau pemilik `ADMINISTER_PROJECTS`; approver default piagam = lead project, bukan pemanggil.
- Web trigger `accord-dev-diag` menolak semua aksi (404) kecuali `ACCORD_DIAG_ENABLED=true`.
- Deal sheet, Inbox, dan Contracts hanya untuk approver/lead tim terkait atau user yang bisa browse issue sumber/deliverable; account id mentah tidak lagi dikirim ke UI.
- Pembuat request wajib punya izin browse + comment di issue sumber; batas 10 request per jam per user.
- Error ke klien kini generik dengan kode referensi; detail hanya di `forge logs`.

### Fixed
- Request bisa macet di `negotiating` bila broker selesai tapi transisi status hilang; round 2 kini melanjutkan transisinya.
- Race reject vs approve: approval disisipkan hanya selama status `awaiting-approval` (INSERT … SELECT), reject mengklaim status dulu, dan UI tidak lagi menerima status `rejected` palsu.
- Arah link Blocks: deliverable "blocks" issue sumber, dicek peka arah (terverifikasi di site).
- Deliverable ganda setelah crash: intent di SQL sebelum create + jeda pencarian JQL; opsi kontrak diambil dari kontrak tersimpan.
- Redaksi key memakai batas kata (PAY-1 tidak mengenai PAY-11) dan juga meredaksi `sources`.
- Request yatim saat push antrean gagal kini berstatus `failed`.
- Komentar Accord maksimal sekali per issue/langkah (penanda SQL).
- Byline "Accord charter" di Confluence menampilkan "Unknown SQL execution error": byline kini memvalidasi halaman piagam langsung dari isi halaman tanpa Forge SQL (database instalasi Confluence terpisah dari Jira), dan error resolver dicatat ke `forge logs`.
- Push ke queue Forge (`accord-negotiation`, `accord-demo-seed`) selalu `400 Bad Request`: modul `consumer` kini memakai format `@forge/events` v2+ (`function`, bukan `resolver`) dan consumer membaca `event.body` dari `AsyncEvent`.
- Form permintaan di issue panel kehilangan karakter saat diketik cepat: kini memakai `Form`/`useForm` UI Kit (tak terkontrol); field project key di tab Teams juga tak terkontrol.
- Tombol approve tetap aktif untuk tim yang sudah approve; kini hanya tim yang belum memutuskan (atau saat kedua tim memilih opsi berbeda) yang bisa approve.
- Judul "Accord" tampil dua kali di global page.

### Changed
- Scope tambahan Jira/Confluence untuk Agile API, pembuatan project, space, dan label.
- Data planning Jira dimuat sekali per job putaran 1; Inbox/Contracts tanpa N+1 dan filter viewer sebelum limit.
- Retry antrean: 5 percobaan (batas 4 retry Forge) dengan backoff 10/20/40/80 detik.
- Migrasi v012–v014: UNIQUE `dependency_edges.contract_id`, index `requests.source_issue_key` dan `contracts.deliverable_issue_key`.
- Validasi project key di JQL dan `costClass` di action Rovo hanya nilai enum.
- Deal sheet dirapikan: satu kartu opsi rekomendasi/disepakati di atas, opsi lain di bawahnya, detail ("Why these numbers", aturan piagam, pratinjau perubahan Jira) dan transkrip bisa dilipat; status per tim ("Mobile lead: approved by you · Payments lead: decision pending"); setelah kontrak aktif tampil "Changes applied" dengan tautan issue deliverable, link, pemindahan sprint, dan komentar.
- Pesan keputusan memakai nama opsi + rentang tanggal, bukan ID internal opsi.
- Issue panel memperbarui badge status sendiri (polling terbatas, refresh setelah kirim/keputusan/tutup modal) dengan tombol Refresh sebagai cadangan.
