# Alfen
This app will let you connect your Alfen charger over the local network with Homey. Currently it only supports reading of data and not updating settings.

** NOTE ** The app will only work if your charger is of a supported type and if your charger lives in the same subnet as your Homey. This is a security limitation created by Alfen and there is no work-around.

** NOTE ** Alfen only supports ONE connection at a time. This means that you can't use Homey and your Alfen (e.g. MyEve) app at the same time. If you encounter connection issues. Please logout of your Alfen Mobile App (if you want to use the Homey app) or temporarily turn off the Homey app (if you want to use your mobile app). This is a security limitation by Alfen and there is no work-around.

** NOTE ** The app can only connect to certain Alfen chargers. This is due to the fact that Alfen didn't publish their APIs so I can only add support for the type that I have at home. If you need support for other chargers of Alfen, please debug their API and add it to this app through a pull request.
