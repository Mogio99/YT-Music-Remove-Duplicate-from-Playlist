# YTM Duplicate Cleaner

Estensione Edge/Chrome (Manifest V3) che trova ed elimina i duplicati nelle playlist di YouTube Music.

A differenza delle estensioni che simulano click sul DOM (fragili, e spesso la cancellazione semplicemente non avviene), questa usa l'API interna InnerTube — la stessa che usa la pagina — autenticata con i cookie di sessione:

| Operazione | Endpoint |
|---|---|
| Scan | `POST /youtubei/v1/browse` con `browseId=VL<playlistId>` + continuation |
| Rimozione | `POST /youtubei/v1/browse/edit_playlist` con `ACTION_REMOVE_VIDEO` + `setVideoId` |

Niente auto-scroll della pagina: una playlist da 1200+ tracce viene letta in pochi secondi.

## Installazione

Non è pubblicata sugli store, si installa in modalità sviluppatore:

1. Scarica l'ultima release (o clona il repo) ed estrai la cartella
2. **Edge**: `edge://extensions` → attiva *Modalità sviluppatore* → **Carica decompressa**
   **Chrome**: `chrome://extensions` → *Modalità sviluppatore* → **Carica estensione non pacchettizzata**
3. Seleziona la cartella che contiene `manifest.json`
4. Apri una tua playlist su music.youtube.com (ricarica la pagina se era già aperta)
5. Clicca l'icona dell'estensione → **Scansiona duplicati**

## Uso

- Lo scan raggruppa i brani con **titolo + artista normalizzati** uguali: ignora tag cosmetici (`(Official Video)`, `(Audio)`, `(Lyrics)`), maiuscole, accenti e differenze di album.
- **Non** accorpa versioni realmente diverse: `live`, `remix`, `acoustic`, `unplugged`, `instrumental`, `cover`, `remaster`.
- Badge dei gruppi:
  - `COPIA ESATTA` — stesso `videoId`, è sicuramente lo stesso file
  - `FEAT — VERIFICA` — differiscono per il featuring (es. `R.I.P.` vs `R.I.P. (feat. Skylar Grey)`): vengono segnalati ma il default è **non toccare**, decidi tu
- Per ogni gruppo la combobox **Tieni:** sceglie quale copia conservare, oppure *Non toccare questo gruppo*.
- **Rimuovi duplicati** elimina le altre copie, una alla volta con un delay di 350 ms, e riporta l'esito per traccia.

## Limiti noti

- Funziona solo su playlist **di cui sei proprietario**: la rimozione richiede il `setVideoId`, presente solo se puoi modificare la playlist.
- InnerTube è un'API non documentata: se Google ne cambia la struttura, va aggiornato il parsing.
- La rimozione non è annullabile in blocco (c'è un `confirm` prima di procedere).
- I brani nella sezione *Suggerimenti* della pagina sono esclusi dallo scan by design.

## Privacy

Nessun dato lascia il browser. L'estensione non ha backend, non raccoglie telemetria e non contatta alcun server diverso da `music.youtube.com`, usando la sessione già attiva dell'utente.

## Licenza

MIT — vedi [LICENSE](LICENSE).

Progetto non affiliato a Google o YouTube.
