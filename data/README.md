# Real-data sample

`openflights-sample.json` is a small extract (30 airlines, 31 airports) of public data from the
[OpenFlights](https://github.com/jpatokal/openflights) project (`data/airlines.dat`, `data/airports.dat`).

- **License:** Open Database License (ODbL) 1.0. Credit: OpenFlights and the sources it lists (for example OurAirports). This extract is shared under the same license.
- **Selection (reproducible):** airlines are the first 30 rows; airports are every 256th row. Rebuild with `node scripts/build-real-sample.mjs <folder with the two .dat files>`.
- **Why real data:** missing values appear as `\N`, `-`, `N/A` and empty strings, sometimes in one column. That mess is what the real-data cases test (`cases/real.mjs`).
- Nothing here is related to any employer or private data.
