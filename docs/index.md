# Alfen Homey App
This app allows you to connect your Alfen EV charger to Homey over your local network. It provides real-time energy monitoring and enables control of several charging settings using Homey Flow cards.

## Supported features
The following settings can be controlled through Homey **(USE AT YOUR OWN RISK):**
- Authentication Mode (Plug & Charge / RFID)
- Charge Type (Normal, Comfort, Green)
- Comfort Charge Level  
  (Minimum charge level when Comfort mode is active, regardless of available solar energy)
- Green Share  
  (Percentage of green energy to be used when charging in Green mode)
- Current Limit (1A – 32A)  
  *(Charging cannot be fully stopped using current limit. To stop charging, switch to Charge Type: Green.)*

⚠️ Changing these values via Homey may interfere with existing charge management systems.

## Network requirement
This app only works if:

- Your charger is a supported Alfen model
- Your charger and Homey are on the **same subnet**

This is a security restriction imposed by Alfen and cannot be bypassed.

## Web API limitation
Alfen chargers support **only one active API connection at a time**.

This means:
- You cannot use the Homey app and the Alfen mobile app simultaneously.
- If you experience connection issues:
  - Close the Alfen mobile app when using Homey
  - Or temporarily disable the Homey app when using the mobile app

This is a limitation of Alfen’s Web API.

## Supported chargers
Alfen has not published their API specifications.  
Therefore, support is limited to chargers that could be tested and reverse-engineered.

If you would like to add support for additional Alfen models, you are welcome to contribute by submitting a pull request.

## Disclaimer
This project is not affiliated with or endorsed by Alfen.  
Use this application at your own risk.
