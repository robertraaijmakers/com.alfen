# Alfen Single/Duo Homey App

This app adds support for **Alfen Single and Duo EV chargers** and ensures the charger is correctly recognized as a charge point in Homey Energy.

The app provides several basic controls to regulate the charging process.  
⚠️ **Please note:** Changing charging settings via Homey may interfere with your existing charge management system. Use these features at your own risk.

---

## Network requirement

For this app to function correctly, **Homey and the charger must be on the same subnet**.

If your network contains multiple subnets (for example through VLANs, mesh systems, or advanced routers), make sure both devices are connected to the same subnet.  
This is a limitation imposed by Alfen for security reasons.

---

## Web API limitation

Alfen chargers only support **one active Web API connection at a time**.

This means:

- If the Alfen smartphone app is open, Homey may fail to refresh or update data.
- Always close the Alfen smartphone app when using this Homey app.

---

## Supported devices

- Alfen Single charger
- Alfen Duo charger (both sockets supported as separate Homey devices)

---

## Homey Energy

The charger is automatically registered as an EV charger in Homey Energy and supports power and energy monitoring.

---

## Support & information

For updates, bug reports and discussions:

- GitHub: https://github.com/henriapperloo-creator/com.alfen
- Homey Community: https://community.homey.app/t/alfen-charger-ondersteuning-voor-duo-laadpalen-toegevoegd/148907

---

## Disclaimer

This project is not affiliated with or endorsed by Alfen.  
Use this app at your own risk.
