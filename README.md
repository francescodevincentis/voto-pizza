# 🍕 Voto Pizza: voto segreto dei giudici con QR code

Prototipo dimostrativo per il Campionato di Pizza Contemporanea.
Nessuna installazione di pacchetti: serve solo **Node.js 18 o superiore**.

## Avvio
Doppio clic su `avvia.command` (Mac), oppure da Terminale nella cartella:

    node server.js

Poi apri **http://localhost:3000/admin** (password predefinita: `pizza2026`,
cambiabile avviando con `ADMIN_PASSWORD=... node server.js` prima del primo avvio).
Al primo avvio vengono caricati dati demo: 8 concorrenti, 5 giudici, 5 criteri.

## Come funziona
1. **Regia** (`/admin`): concorrenti, giudici, criteri con pesi, scala di voto (1–10 di default).
2. **Stampa QR** (`/stampa`): pettorine dei concorrenti e badge personali dei giudici.
3. **Il giudice** inquadra *una volta* il proprio badge: il telefono resta abilitato.
   Da lì inquadra la pettorina, sceglie un voto per ogni criterio, conferma. Il voto è definitivo.
4. **Segretezza**: finché la votazione è aperta nessuno vede i punteggi, nemmeno la regia,
   che vede solo *chi* ha votato *chi*. Il server rifiuta di calcolare la classifica prima della rivelazione.
5. **Chiudi votazione → Rivela classifica**: compare la classifica in regia (con export CSV)
   e sullo **schermo** `/classifica`, da proiettare: si svela un posto alla volta (barra spaziatrice), dall'ultimo al primo.

## Calcolo del punteggio
- Punteggio di un giudice = media pesata dei criteri.
- Totale concorrente = somma dei punteggi dei giudici (mostrata anche la media).

## Per la demo con i telefoni
Il computer e i telefoni devono essere sulla **stessa Wi-Fi**. In Regia → Impostazioni
metti come "Indirizzo usato nei QR" quello suggerito (es. `http://192.168.1.20:3000`), poi stampa i QR.
Per un evento reale il server va messo online (HTTPS, dominio), e i QR andranno ristampati con quell'indirizzo.

## Dati
Tutto è salvato in `data.json`. Per ripartire da zero: Regia → Azzera.
