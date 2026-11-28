#!/bin/bash
# Avvia Voto Pizza sul portatile. Apre la regia con l'indirizzo di rete
# (non "localhost"), così i QR stampati puntano al portatile e i telefoni
# collegati alla stessa Wi-Fi li possono aprire, anche senza Internet.
cd "$(dirname "$0")"
IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null)
[ -z "$IP" ] && IP=localhost
echo ""
echo "  Indirizzo del portatile sulla Wi-Fi: $IP"
[ "$IP" = localhost ] && echo "  ATTENZIONE: il Mac non è collegato a nessuna Wi-Fi. Collegalo e riavvia."
( sleep 1; open "http://$IP:3000/admin" ) &
node server.js
