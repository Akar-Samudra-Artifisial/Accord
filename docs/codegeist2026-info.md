# Codegeist 2026 — Info Kompetisi

> Diambil dari halaman resmi pada 2026-11-05. Kutipan dalam bahasa Inggris dipertahankan apa adanya.

## 1. Ringkasan

- **Judul**: "Codegeist 2026: Build with context. Ship with confidence."
- **Sumber**: https://codegeist2026.devpost.com/
- **Penyelenggara (Sponsor)**: Atlassian Pty Ltd, Sydney, Australia. Sumber: https://codegeist2026.devpost.com/rules (§2)
- **Administrator**: Devpost, Inc., New York. Sumber: https://codegeist2026.devpost.com/rules (§2)
- **Kontak hackathon manager**: janet@devpost.com
- **Tema**: "Atlassian's Teamwork Graph connects goals, work, people, decisions, and outcomes..." Tugasnya: "Build an app on Atlassian's Forge platform that uses that context to help teams ship with confidence."
- **Platform wajib**: Atlassian Forge. Proyek harus "integrate with at least one Atlassian product or platform capability (Jira, Confluence, Jira Service Management, Bitbucket, Teamwork Graph, Rovo)". Sumber: /rules (Project Requirements)
- **Format**: Online | Public. Peserta: 1616 (saat scrape).
- **Tag**: Machine Learning/AI, Enterprise, Productivity.

## 2. Timeline & Deadline

Sumber: https://codegeist2026.devpost.com/rules (§1), pembanding https://codegeist2026.devpost.com/details/dates

| Periode | Rules (§1) | Halaman dates / overview |
|---|---|---|
| Registration | 27 Okt 2026 (9:00 am PT) – 22 Des 2026 (12:00 pm PT) | — |
| Submission | 27 Okt 2026 (9:00 am PT) – 22 Des 2026 (12:00 pm PT) | "October 27 at 12:15PM EDT" – "December 22 at 3:00PM EST"; overview: "Deadline: Dec 22, 2026 @ 3:00pm EST" |
| Judging | 5 Jan 2027 (1:00 pm PT) – 3 Feb 2027 (5:00 pm PT) | — |
| Winners | "On or around Monday, February 15, 2027 (9:00 am Pacific Time)" | "February 15 at 12:00PM EST" |

- Per 5 Nov 2026: submission period berjalan, sisa ±47 hari.
- Deadline 22 Des 12:00 PM PT = 3:00 PM EST = **23 Des 2026 03:00 WIB**.

## 3. Kategori & Hadiah

Sumber: /rules (§8, Project Requirements), /resources

### Kategori utama
1. **Apps for Software Teams**: "Give dev teams the context to ship with confidence. Think smarter code reviews, deployment awareness, issue triage that actually understands what matters."
2. **Apps for Business Teams**: "Give business teams the context to act decisively. Help colleagues in marketing, sales, HR, finance, support, or legal move faster with the right information in front of them."
3. **Apps for Specialized Industries**: "Give experts in healthcare, finance, manufacturing, automotive, or other fields the context to do their best work. Turn insider knowledge into solutions built for your world."

Panitia boleh memindahkan proyek ke kategori/bonus lain.

### Grand Prizes (per kategori)
| Juara | Hadiah | Pemenang |
|---|---|---|
| 1st | $15,000 + 2 tiket Team 2027 (AMER, travel tidak termasuk) + blog Atlassian + swag Atlassian Williams Racing | 3 |
| 2nd | $8,000 + kesempatan tampil di blog pemenang | 3 |
| 3rd | $5,000 + kesempatan tampil di blog pemenang | 3 |

Total: "$120,000+ in prizes".

### Bonus Prizes ($1,500 masing-masing, 6 pemenang)
1. **Best Agents - Rovo/Assignable agents**: Forge app dengan modul `rovo:agent`, `rovo:agentConnector`, atau `rovo:skill` dan `rovo:action` reusable yang bisa dipanggil agent lain sebagai tool.
2. **Best app with Atlassian MCP**: Forge app yang mengekspos tools via Atlassian MCP server memakai modul `rovo:mcp`; boleh dikombinasi skill.md open-source untuk agent pihak ketiga.
3. **Best apps with Teamwork Graph integration**: memasukkan data ke graph dan/atau mengonsumsi Teamwork Graph API.
4. **Best Marketplace published app**: dipublikasikan ke Marketplace atau sudah disubmit untuk listing (link listing atau tiket review).

### Participation Prize
- Atlassian Developer Swag Pack, 300 pemenang, first-come first-serve (maks 4 per submission).

### Aturan kombinasi
- Satu submission maks 1 Grand Prize + 1 Bonus Prize.
- Boleh submit beberapa proyek unik; maks 1 Participation Prize per entrant.
- Pemenang isi affidavit/form dalam 10 hari kerja; hadiah dikirim ≤60 hari; pajak ditanggung pemenang (W-8BEN untuk non-AS).

## 4. Syarat Kelayakan

Sumber: /rules (§3), overview
- Umur: minimal usia dewasa di negara domisili.
- Individu, tim (wajib tunjuk 1 Representative), atau organisasi.
- Negara dikecualikan: Belarus, Brazil, Crimea, Cuba, Iran, Korea Utara, Myanmar, Quebec, Russia, Sudan, Syria, dan negara OFAC lain. **Indonesia tidak dikecualikan.**
- Dikecualikan: karyawan/agen Sponsor & Administrator beserta keluarga, juri dan perusahaannya.
- Beberapa submission boleh asal "unique and substantially different".

## 5. Persyaratan Submission

Sumber: overview (What to Submit), /rules (§4)
1. **Installation link** untuk juri + instruksi lengkap. Cara: https://developer.atlassian.com/platform/forge/distribute-your-apps/#start-sharing-your-app
2. **Demo video**: < 5 menit (juri tidak wajib menonton > 3 menit), menunjukkan app berjalan, upload YouTube publik, tanpa musik/merek berhak cipta tanpa izin.
3. **Category** + bonus prize yang sesuai beserta materi yang diminta.
4. **Explanation** pemenuhan teknologi wajib (Forge + ≥1 produk Atlassian).
5. **Text description** fitur & fungsi.
6. **Instruksi konfigurasi** lengkap untuk semua langkah & integrasi.
7. **Bahasa Inggris** (atau sertakan terjemahan).
8. App harus bisa diinstal di lingkungan juri dan berfungsi seperti di video.
9. Isi seluruh form Devpost sebelum deadline; setelah deadline tidak bisa diubah.
10. Akun Devpost + Atlassian Cloud Developer License gratis (https://developer.atlassian.com/cloud/).

## 6. Kriteria Penilaian

Sumber: overview (Judging Criteria), /rules (§6)

Tahap 1 (pass/fail): sesuai tema dan memakai API/SDK wajib.

Tahap 2, masing-masing **20%**:
1. **Technological Implementation**: "How thoroughly and skillfully does the project use the Atlassian's Forge platform and at least one Atlassian product or platform capability...? Does the project reflect genuine effort and a working, non-trivial implementation?"
2. **Design**: "Does the project deliver a complete, coherent product experience — not just a technical proof of concept?"
3. **Potential Impact**: "Does the project make a credible, specific case for solving a real problem for a real audience — and does the solution actually address that problem based on what's demonstrated?"
4. **Innovation/Idea**: "How creative and novel is the concept and does the project differ from existing concepts?"
5. **Presentation**: "Does the video clearly demonstrate the project working end-to-end? Does the pitch communicate what problem is solved, who it's for, and why it matters? Is the overall presentation easy to follow?"

Tie-break: urut kriteria dari pertama; masih seri → voting juri.

## 7. Larangan & Batasan

Sumber: /rules
- **Proyek baru vs lama**: baru dibuat, atau proyek lama yang "must have been updated or rebuilt in the Forge platform after the start of the Hackathon Submission Period and must have a Forge manifest file and include at least one Forge module".
- Karya original, dimiliki peserta, tidak melanggar IP. Bantuan teknis pihak ketiga boleh asal hak tetap milik peserta.
- Open source boleh sesuai lisensi dan proyek harus membangun di atasnya.
- SDK/API/data pihak ketiga harus sesuai syaratnya.
- Tidak boleh berasal dari proyek yang didanai/dikontrak Sponsor/Administrator.
- Tunduk pada https://developer.atlassian.com/platform/marketplace/atlassian-developer-terms/
- Publisitas: nama/rupa/suara boleh dipakai promosi hingga 3 tahun.
- **Kebijakan AI**: tidak ditemukan aturan khusus.

## 8. Resources Resmi

Sumber: https://codegeist2026.devpost.com/resources

**Setup & docs**
- Cloud Developer License: https://go.atlassian.com/cloud-dev
- Getting Started Forge: https://developer.atlassian.com/platform/forge/getting-started/
- Tutorials: https://developer.atlassian.com/platform/forge/tutorials-and-guides/
- Forge Realtime EAP: https://developer.atlassian.com/platform/forge/realtime/
- Modul Rovo: https://developer.atlassian.com/platform/forge/manifest-reference/modules/rovo-agent/ (juga rovo-agent-connector, rovo-skill, rovo-action, rovo-mcp)
- Teamwork Graph API: https://developer.atlassian.com/platform/teamwork-graph/call-the-teamwork-graph-api/

**Sample apps**
- Jira: https://developer.atlassian.com/platform/forge/example-apps-jira/
- JSM: https://developer.atlassian.com/platform/forge/example-apps-jsm/
- Confluence: https://developer.atlassian.com/platform/forge/example-apps-confluence/
- Bitbucket: https://developer.atlassian.com/platform/forge/example-apps-bitbucket/
- Compass: https://developer.atlassian.com/platform/forge/example-apps-compass/
- Rovo: https://developer.atlassian.com/platform/forge/example-apps-rovo/
- Komunitas: github.com/dugaldmorrow/forge-ai-basics, forge-bulk-issue-ops, forge-ai-sprint-builder

**Video**
- Codegeist 2026 Getting Started: https://youtu.be/uac46B7aXmA
- Customizing Confluence: https://go.atlassian.com/customizing-confluence-forge
- Customizing Jira: https://go.atlassian.com/customizing-jira-forge
- Building a Rovo agent: https://www.youtube.com/watch?v=nmGTbxCnzvw

**Distribusi & Marketplace**
- Distribute apps: https://developer.atlassian.com/platform/forge/distribute-your-apps/
- Listing Forge apps: https://developer.atlassian.com/platform/marketplace/listing-forge-apps/
- Marketplace: https://marketplace.atlassian.com/

**Bantuan**
- Community (tag `codegeist-2026`): https://community.developer.atlassian.com/

## 9. Update Terbaru

- /updates: belum ada pengumuman (per 2026-11-05).
- /forum_topics: "No topics have been created yet."
- Docs distribusi Forge diperbarui 30 Okt 2026.

## 10. Perlu Dicek Ulang

1. Waktu buka submission: rules 9:00 am PT vs dates "12:15PM EDT" (selisih 15 menit, tidak berdampak).
2. Kebijakan AI/LLM tidak ada di rules — tanya panitia/forum bila perlu.
3. Nama bonus MCP beda di rules vs resources; syarat sama (`rovo:mcp`).
4. Bonus Rovo jalur skill/action: anggap butuh `rovo:skill` dan `rovo:action`.
5. Bila Accord sudah ada sebelum 27 Okt 2026, harus di-rebuild di Forge setelah tanggal itu + manifest + modul Forge.
6. Definisi "submitted for listing" (bonus Marketplace) tidak rinci.
7. Daftar juri & sponsor tambahan tidak dicantumkan.
8. /participants dan /project-gallery belum di-scrape.
