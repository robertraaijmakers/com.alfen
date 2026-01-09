Alfen Single/Duo Homey App
This app adds support for Alfen Single and Duo EV chargers and ensures the charger is correctly recognized as a charge point in Homey Energy.
The app provides several basic controls to regulate the charging process.
⚠️ Please note: Changing charging settings via Homey may interfere with your existing charge management system. Use these features at your own risk.

Network requirement
For this app to function correctly, Homey and the charger must be on the same subnet.
If your network contains multiple subnets (for example through VLANs, mesh systems, or advanced routers), make sure both devices are connected to the same subnet.
This is a limitation imposed by Alfen for security reasons.

Web API limitation
Alfen chargers only support one active Web API connection at a time.
This means:
If the Alfen smartphone app is open, Homey may fail to refresh or update data.
Always close the Alfen smartphone app when using this Homey app.

More information
More information, updates, and support can be found via the links at the bottom of the Homey App Store page.