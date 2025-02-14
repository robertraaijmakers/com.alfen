# Alfen
This app adds support for the Alfen charger (single connection) and will make sure the charger is shown as chargepoint in Homey Energy.
The app supports a couple of basic actions to regulate the way of charging. Please note that updating these settings through Homey might cause issues with your charge management system and is at own risk!

*Please note:* for this app to work your Homey and the Charger must be connected to the same SUBNET. So if you have different subnets within your household, make sure the charger and your Homey are in the same. Otherwise you cannot login, this is a limitation/security measure on Alfen side.

*Please note:* Alfen doesn't support multiple connections through the WebAPI. That means that you will encounter errors with refreshing and setting data once you have your Alfen app open on your smartphone simultanously when running this app on your Homey. Make sure to close your smartphone app when submitting changes and refreshing data.

More information can be found here: https://robertraaijmakers.github.io/com.alfen/