#!/bin/bash
cd "$(dirname "$0")"
( sleep 1; open "http://localhost:3000/admin" ) &
node server.js
