# Alfen
This app will let you connect your Alfen charger over the local network with Homey. It will display the most important energy information and also gives you the ability to control some settings through a custom flow!

Settings that you are able to set (USE AT OWN RISK):
- Authentication Mode (plug & charge and RFID);
- Charge Type (Normal, Comfort, Green)
- Comfort Charge Level (when charge type is Comfort, this is the minimum that will be charged regardless of how much redelivery takes place)
- Green Share (% of how much green energy should be used (I think applied when you set your thing to green… but not sure)
- Current Limit (1A - 32A): It can’t be set to 0. So the only way to fully stop charging is probably switching the charger to Charge Type: Green.

*NOTE* The app will only work if your charger is of a supported type and if your charger lives in the same subnet as your Homey. This is a security limitation created by Alfen and there is no work-around.

*NOTE* Alfen only supports ONE connection at a time. This means that you can't use Homey and your Alfen (e.g. MyEve) app at the same time. If you encounter connection issues. Please logout of your Alfen Mobile App (if you want to use the Homey app) or temporarily turn off the Homey app (if you want to use your mobile app). This is a security limitation by Alfen and there is no work-around.

*NOTE* The app can only connect to certain Alfen chargers. This is due to the fact that Alfen didn't publish their APIs so I can only add support for the type that I have at home. If you need support for other chargers of Alfen, please debug their API and add it to this app through a pull request.
