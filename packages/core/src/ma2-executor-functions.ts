/** Codes read from native MA2 3.7 Page exports after assigning each documented function. */
export const ma2ExecutorFunctions: Readonly<Record<number, { name: string; momentary: boolean }>> = {
  12299: { name: 'Go', momentary: false }, 12297: { name: 'GoBack', momentary: false },
  12298: { name: 'Pause', momentary: false }, 12290: { name: 'Off', momentary: false },
  12293: { name: 'On', momentary: false }, 12307: { name: 'Toggle', momentary: false },
  12302: { name: 'Flash', momentary: true }, 12291: { name: 'Temp', momentary: true },
  12306: { name: 'Swop', momentary: true }, 12322: { name: 'SwopOn', momentary: true },
  12323: { name: 'SwopGo', momentary: true }, 12320: { name: 'FlashOn', momentary: true },
  12321: { name: 'FlashGo', momentary: true }, 12303: { name: 'Black', momentary: true },
  12292: { name: 'Top', momentary: false }, 12301: { name: 'Load', momentary: false },
  12325: { name: 'LoadNext', momentary: false }, 12305: { name: 'Select', momentary: false },
  12295: { name: 'Learn', momentary: false }, 12308: { name: 'Rate1', momentary: false },
  12318: { name: 'ToFull', momentary: false }, 12319: { name: 'ToZero', momentary: false }
};
