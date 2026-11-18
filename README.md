# 🍕 Voto Pizza: voto segreto dei giudici con QR code

Prototipo dimostrativo per il Campionato di Pizza Contemporanea.
Nessuna installazione di pacchetti: serve solo **Node.js 18 o superiore**.

## Avvio
Doppio clic su `avvia.command` (Mac), oppure da Terminale nella cartella:

    node server.js

Poi apri **http://localhost:3000/admin**: sul computer che fa girare l'app la regia si apre senza password.
Da altri dispositivi o sul sito online serve la password (predefinita: `pizza2026`,
cambiabile avviando con `ADMIN_PASSWORD=... node server.js` prima del primo avvio).
Al primo avvio vengono caricati dati demo: 12 concorrenti in varie categorie, 3 giudici di gusto e 2 di forno.

## Come funziona
1. **Regia** (`/admin`): concorrenti (con categoria), giudici (di gusto o di forno), regolamento, scala di voto (1–100).
2. **Stampa QR** (`/stampa`): pettorine dei concorrenti e badge personali dei giudici.
3. **Il giudice** inquadra *una volta* il proprio badge: il telefono resta abilitato.
   Da lì inquadra la pettorina, sceglie un voto per ogni criterio, conferma. Il voto è definitivo.
4. **Segretezza**: finché la votazione è aperta nessuno vede i punteggi, nemmeno la regia,
   che vede solo *chi* ha votato *chi*. Il server rifiuta di calcolare la classifica prima della rivelazione.
5. **Chiudi votazione → Rivela classifica**: compare la classifica in regia (con export CSV)
   e sullo **schermo** `/classifica`, da proiettare: si svela un posto alla volta (barra spaziatrice), dall'ultimo al primo.

## Regolamento Pizza 2026
Le categorie e i criteri stanno in Regia → **Regolamento**, un testo semplice modificabile prima che arrivino voti:

    # Classica
    gusto: Gusto | Cottura | Presentazione
    forno: Etica professionale e pulizia

    # Napoletana
    forno ±5: Impasto | Divisa | Pomodoro 60/80 gr | ...

- `gusto:` / `forno:` = criteri con voto da 1 a 100, per i giudici di gusto o di forno.
- `forno ±5:` = lista di controllo: ogni voce rispettata vale +5, non rispettata −5.
- Ogni concorrente può iscriversi a **più gare** (Regia → Concorrenti → "+ gara"), con una sola pettorina e un solo QR.
  Quando il giudice inquadra la pettorina di chi fa più gare, il telefono gli chiede quale gara sta votando.
  Voti, bonus/malus e classifica sono separati per ogni gara.
- Ogni giudice vede solo i criteri della gara che spettano al suo ruolo.

## Team
20 team precaricati (nomi modificabili in Regia → Impostazioni), **massimo 4 concorrenti ciascuno**, ogni concorrente in un solo team.
In Regia → Concorrenti si sceglie il team da un menu: quelli già pieni non si possono selezionare.
Dopo la rivelazione c'è anche la **classifica a squadre**: punteggio del team = somma dei totali dei suoi concorrenti
nelle gare che contano per la squadra. **Chef, Genio e follia, Napoletana e Amatoriale non contano** (modificabile in Regia → Impostazioni).

## Calcolo del punteggio
- Una **classifica separata per ogni categoria**.
- Totale concorrente = somma dei punti di tutti i giudici (gusto + forno, lista di controllo compresa) + eventuali bonus/malus.
- I dati della versione precedente (scala 1–10) vengono convertiti al primo avvio: concorrenti e giudici restano
  (vanno assegnate categoria e tipo di giudice), i vecchi voti di prova vengono messi da parte.

## Solo numeri per i giudici
I giudici vedono solo il **numero** del concorrente (né sul telefono né sulla pettorina compare il nome).
Il nome in Regia è facoltativo: l'abbinamento numero → nome può restare su un foglio Excel a parte,
oppure si può incollare da Excel (Regia → Concorrenti → "Importa da Excel") per vederlo in classifica finale.

## Bonus / malus al volo
In Regia, riquadro **Bonus / malus**: pulsanti **+2 / −2** per ogni concorrente, con motivo facoltativo.
Il valore si somma al totale dei giudici; ogni modifica resta nello storico e si può annullare.
Il bonus/malus è conteggiato nel totale ma **non si vede** in classifica, sullo schermo né nel CSV: compare solo nel riquadro Bonus/malus della regia.

## Per la demo con i telefoni
Il computer e i telefoni devono essere sulla **stessa Wi-Fi**. In Regia → Impostazioni
metti come "Indirizzo usato nei QR" quello suggerito (es. `http://192.168.1.20:3000`), poi stampa i QR.
Per un evento reale il server va messo online (HTTPS, dominio), e i QR andranno ristampati con quell'indirizzo.

## Dati
Tutto è salvato in `data.json`. Per ripartire da zero: Regia → Azzera.
