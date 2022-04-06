import Clipboard from '@react-native-clipboard/clipboard';
import React, { Dispatch, SetStateAction, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Platform, View } from 'react-native';
import { FlatList } from 'react-native-gesture-handler';
import * as ScopedStorage from 'react-native-scoped-storage';
import RNFetchBlob from 'rn-fetch-blob';
import DialogHeader from '../../components/dialog/dialog-header';
import { Button } from '../../components/ui/button';
import { IconButton } from '../../components/ui/icon-button';
import Input from '../../components/ui/input';
import { PressableButton } from '../../components/ui/pressable';
import Seperator from '../../components/ui/seperator';
import { SvgView } from '../../components/ui/svg';
import Heading from '../../components/ui/typography/heading';
import Paragraph from '../../components/ui/typography/paragraph';
import { eSendEvent, presentSheet, ToastEvent } from '../../services/event-manager';
import { useUserStore } from '../../stores/stores';
import { ThemeStore, useThemeStore } from '../../stores/theme';
import { db } from '../../utils/database';
import Storage from '../../utils/database/storage';
import { eCloseProgressDialog } from '../../utils/events';
import useTimer from '../../utils/hooks/use-timer';
import { sanitizeFilename } from '../../utils/sanitizer';
import { SIZE } from '../../utils/size';
import { sleep } from '../../utils/time';
import { CustomButton } from './button';
import { verifyUser } from './functions';
import SectionHeader from './section-header';

const TwoFactorAuth = ({ isSheet }: { isSheet: boolean }) => {
  const [collapsed, setCollapsed] = useState(isSheet ? false : true);
  const user = useUserStore(state => state.user);

  const enable2fa = () => {
    verifyUser('global', async () => {
      MFASheet.present();
    });
  };

  const disable2fa = () => {
    verifyUser('global', async () => {
      await db.mfa?.disable();
      let user = await db.user?.fetchUser();
      useUserStore.getState().setUser(user);
    });
  };

  const mfaSettingsList = user?.mfa?.isEnabled
    ? [
        {
          name: user.mfa?.secondaryMethod
            ? 'Reconfigure fallback 2FA method'
            : 'Add fallback 2FA method',
          func: () => {
            verifyUser('global', async () => {
              MFASheet.present(true);
            });
          },
          desc: 'You can use fallback 2FA method incase you are unable to login via primary method'
        },
        {
          name: 'View recovery codes',
          func: () => {
            verifyUser('global', async () => {
              MFARecoveryCodes.present('sms');
            });
          },
          desc: 'View and save recovery codes for to recover your account'
        },
        {
          name: 'Disable two-factor authentication',
          func: disable2fa,
          desc: 'Decreased security for your account'
        }
      ]
    : [
        {
          name: 'Enable two-factor authentication',
          func: enable2fa,
          desc: 'Increased security for your account'
        }
      ];

  return (
    <>
      {!isSheet && (
        <SectionHeader
          collapsed={collapsed}
          setCollapsed={setCollapsed}
          title="Two Factor Authentication"
        />
      )}

      {!collapsed && (
        <>
          {mfaSettingsList.map(item => (
            //@ts-ignore
            <CustomButton
              key={item.name}
              title={item.name}
              tagline={item.desc}
              onPress={item.func}
            />
          ))}
        </>
      )}
    </>
  );
};

export default TwoFactorAuth;

const mfaMethods: MFAMethod[] = [
  {
    id: 'app',
    title: 'Setup using an Authenticator app',
    body: 'Use an authenticator app like Google Authenticator on your phone to get authentication codes',
    icon: 'cellphone-key',
    recommended: true
  },
  {
    id: 'sms',
    title: 'Set up using SMS',
    body: 'Notesnook will send you an SMS with a 2FA code when prompted',
    icon: 'message-plus-outline'
  },
  {
    id: 'email',
    title: 'Set up using Email',
    body: 'Notesnook will send you a 2FA code on your email when prompted',
    icon: 'email-outline'
  }
];
type MFAMethod = {
  id: 'email' | 'sms' | 'app';
  title?: string;
  body?: string;
  icon?: string;
  recommended?: boolean | undefined;
};

type MFAStep = {
  id: string;
  props: { [name: string]: any };
};

type MFAStepProps = {
  recovery?: boolean;
  onSuccess?: (method?: MFAMethod) => void;
  setStep?: Dispatch<SetStateAction<MFAStep>>;
  method?: MFAMethod;
  isSetup?: boolean;
};
export const MFAMethodsPickerStep = ({ recovery, onSuccess }: MFAStepProps) => {
  const colors = useThemeStore(state => state.colors);
  const user = useUserStore(state => state.user);

  const getMethods = () => {
    if (!recovery) return mfaMethods;
    return mfaMethods.filter(m => m.id !== user?.mfa?.primaryMethod);
  };

  return (
    <>
      <DialogHeader
        title="Two-factor authentication"
        paragraph="Protect your notes by enabling 2 factor authentication"
        padding={12}
      />
      <Seperator />
      {getMethods().map(item => (
        <PressableButton
          key={item.title}
          onPress={() => {
            onSuccess && onSuccess(item);
          }}
          customStyle={{
            paddingHorizontal: 12,
            paddingVertical: 12,
            marginTop: 0,
            marginBottom: 12,
            flexDirection: 'row',
            borderRadius: 0,
            alignItems: 'flex-start'
          }}
        >
          <IconButton
            type="grayBg"
            customStyle={{
              width: 50,
              height: 50,
              marginRight: 10
            }}
            size={20}
            color={item.recommended ? colors.accent : colors.icon}
            name={item.icon}
          />
          <View
            style={{
              flexShrink: 1
            }}
          >
            <Heading size={SIZE.md}>{item.title}</Heading>
            <Paragraph size={SIZE.sm}>{item.body}</Paragraph>
          </View>
        </PressableButton>
      ))}
    </>
  );
};

export const MFASetup = ({ method, onSuccess, setStep, recovery }: MFAStepProps) => {
  const colors = useThemeStore(state => state.colors);
  const user = useUserStore(state => state.user);
  const [authenticatorDetails, setAuthenticatorDetails] = useState({
    sharedKey: null,
    authenticatorUri: null
  });
  const code = useRef<string>();
  const phoneNumber = useRef<string>();
  const { seconds, setId, start } = useTimer(method?.id);

  const [loading, setLoading] = useState(method?.id === 'app' ? true : false);
  const [enabling, setEnabling] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (method?.id === 'app') {
      db.mfa?.setup('app').then(data => {
        setAuthenticatorDetails(data);
        setLoading(false);
      });
    }
  }, []);

  const codeHelpText = {
    app: 'After putting the above code in authenticator app, the app will display a code that you can enter below.',
    sms: 'You will receive a 2FA code on your phone number which you can enter below',
    email: 'You will receive a 2FA code on your email address which you can enter below'
  };

  const onNext = async () => {
    if (!code.current || code.current.length !== 6) return;
    try {
      if (!method) return;
      setEnabling(true);
      if (recovery) {
        console.log('enabling secondary method for 2FA');
        await db.mfa?.enableFallback(method.id, code.current);
      } else {
        console.log('enabling primary method for 2FA');
        await db.mfa?.enable(method.id, code.current);
      }

      let user = await db.user?.fetchUser();
      useUserStore.getState().setUser(user);
      onSuccess && onSuccess(method);
      setEnabling(false);
    } catch (e) {
      const error = e as Error;
      console.log('2fa submit code:', error.message);
      ToastEvent.error(error, 'Error submitting 2fa code');
      setEnabling(false);
    }
  };

  const onSendCode = async () => {
    console.log('send code');
    if (error) return;
    if (!method || sending) return;
    if (method.id === 'app' && authenticatorDetails.sharedKey) {
      Clipboard.setString(authenticatorDetails.sharedKey);
      if (authenticatorDetails.authenticatorUri) {
        await Linking.openURL(authenticatorDetails.authenticatorUri).catch(console.log);
      }

      ToastEvent.show({
        heading: `Code copied!`,
        type: 'success',
        context: 'local'
      });
      return;
    }

    try {
      console.log('seconds', seconds);
      if (seconds) throw new Error('Please wait a few seconds before resending code');
      if (method.id === 'sms' && !phoneNumber.current) throw new Error('Phone number not entered');
      setSending(true);
      await db.mfa?.setup(method?.id, phoneNumber.current);

      if (method.id === 'sms') {
        console.log(phoneNumber.current);
        setId(method.id + phoneNumber.current);
      }
      await sleep(300);
      start(60, method.id === 'sms' ? method.id + phoneNumber.current : method.id);
      setSending(false);
      ToastEvent.show({
        heading: `2FA code sent via ${method.id}.`,
        type: 'success',
        context: 'local'
      });
    } catch (e) {
      setSending(false);
      const error = e as Error;
      console.log('Send code:', error.message);
      ToastEvent.error(error, 'Error sending 2FA code');
    }
  };

  return !method ? null : (
    <View>
      <DialogHeader title={method?.title} paragraph={method?.body} padding={12} />
      <Seperator />

      <View
        style={{
          paddingHorizontal: 12
        }}
      >
        {loading ? (
          <View
            style={{
              justifyContent: 'center',
              alignItems: 'center',
              width: '100%',
              marginBottom: 50
            }}
          >
            <ActivityIndicator
              color={colors.accent}
              style={{
                height: 50
              }}
            />
            <Paragraph>Getting information.. please wait</Paragraph>
          </View>
        ) : (
          <>
            <Input
              loading={method?.id !== 'sms' ? true : false}
              value={
                method?.id === 'email'
                  ? //@ts-ignore
                    user.email
                  : method?.id === 'app'
                  ? authenticatorDetails?.sharedKey || ''
                  : undefined
              }
              multiline={method.id === 'app'}
              onChangeText={value => {
                phoneNumber.current = value;
              }}
              placeholder={method?.id === 'email' ? 'Enter email address' : '+1234567890'}
              onSubmit={() => {
                onSendCode();
              }}
              onErrorCheck={e => setError(e)}
              validationType="phonenumber"
              keyboardType="phone-pad"
              errorMessage="Please enter a valid phone number with country code"
              buttons={
                error ? null : (
                  <Button
                    onPress={onSendCode}
                    loading={sending}
                    title={
                      sending
                        ? null
                        : method.id === 'app'
                        ? 'Copy'
                        : `${seconds ? `Resend code in (${seconds})` : 'Send code'}`
                    }
                  />
                )
              }
            />

            <Heading size={SIZE.md}>Enter the 6-digit code</Heading>
            <Paragraph>{codeHelpText[method?.id]}</Paragraph>
            <Seperator />
            <Input
              placeholder="xxxxxx"
              maxLength={6}
              loading={loading}
              textAlign="center"
              keyboardType="numeric"
              onChangeText={value => (code.current = value)}
              //@ts-ignore
              inputStyle={{
                fontSize: SIZE.lg,
                height: 60,
                textAlign: 'center',
                letterSpacing: 10,
                width: null
              }}
              containerStyle={{
                height: 60,
                borderWidth: 0,
                //@ts-ignore
                width: null
              }}
            />
            <Seperator />
            <Button
              title={enabling ? null : 'Next'}
              type="accent"
              width={250}
              onPress={onNext}
              loading={enabling}
              style={{
                borderRadius: 100,
                marginBottom: 10
              }}
            />

            <Button
              title="Select a different 2FA method"
              type="gray"
              height={25}
              onPress={() => {
                setStep &&
                  setStep({
                    id: 'mfapick',
                    props: {
                      recovery: recovery
                    }
                  });
              }}
            />
          </>
        )}
      </View>
    </View>
  );
};

export const MFARecoveryCodes = ({ method, recovery, onSuccess, isSetup = true }: MFAStepProps) => {
  const colors = useThemeStore(state => state.colors);
  const [codes, setCodes] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const codes = await db.mfa?.codes(true);
        if (codes) setCodes(codes);
        setLoading(false);
      } catch (e) {
        const error = e as Error;
        ToastEvent.error(error, 'Error getting codes', 'local');
        setLoading(false);
      }
    })();
  }, []);

  return (
    <View>
      <DialogHeader
        centered={true}
        title="Save your recovery codes"
        paragraph={`If you lose access to your ${
          method?.id === 'email' ? 'email' : method?.id === 'sms' ? 'phone' : 'auth app'
        }, you can login to Notesnook using your recovery codes. Each code can only be used once.`}
        padding={12}
      />
      <Seperator />

      {loading ? (
        <View
          style={{
            justifyContent: 'center',
            alignItems: 'center',
            width: '100%',
            marginBottom: 50
          }}
        >
          <ActivityIndicator
            color={colors.accent}
            style={{
              height: 50
            }}
          />
          <Paragraph>Getting recovery codes.. please wait</Paragraph>
        </View>
      ) : (
        <>
          <FlatList
            data={codes}
            contentContainerStyle={{
              alignItems: 'center'
            }}
            numColumns={2}
            renderItem={({ item, index }) => (
              <Heading
                style={{ marginHorizontal: 15, marginVertical: 5, fontFamily: 'monospace' }}
                size={SIZE.lg}
              >
                {item}
              </Heading>
            )}
          />
          <Seperator />

          <View
            style={{
              flexDirection: 'row',
              justifyContent: 'center',
              marginBottom: 10
            }}
          >
            <Button
              title="Copy codes"
              fontSize={SIZE.md}
              onPress={() => {
                let codeString = codes.join('\n');
                Clipboard.setString(codeString);
                ToastEvent.show({
                  heading: 'Recovery codes copied!',
                  type: 'success',
                  context: 'global'
                });
              }}
              style={{
                marginRight: 10
              }}
            />

            <Button
              title="Save to file"
              fontSize={SIZE.md}
              onPress={async () => {
                try {
                  let path;
                  let fileName = 'notesnook_recoverycodes';
                  fileName = sanitizeFilename(fileName, { replacement: '_' });
                  fileName = fileName + '.txt';
                  const codeString = codes.join('\n');
                  if (Platform.OS === 'android') {
                    let file = await ScopedStorage.createDocument(
                      fileName,
                      'text/plain',
                      codeString,
                      'utf8'
                    );
                    if (!file) return;
                    path = file.uri;
                  } else {
                    path = await Storage.checkAndCreateDir('/');
                    await RNFetchBlob.fs.writeFile(path + fileName, codeString, 'utf8');
                    path = path + fileName;
                  }

                  ToastEvent.show({
                    heading: 'Recovery codes saved to text file',
                    type: 'success',
                    context: 'local'
                  });
                  return path;
                } catch (e) {}
              }}
            />
          </View>

          <Button
            title={isSetup ? 'Next' : 'Done'}
            type="accent"
            width={250}
            onPress={() => {
              if (isSetup) {
                onSuccess && onSuccess(method);
              } else {
                eSendEvent(eCloseProgressDialog);
              }
            }}
            style={{
              borderRadius: 100,
              marginBottom: 10
            }}
          />
        </>
      )}
    </View>
  );
};

MFARecoveryCodes.present = (methodId: MFAMethod['id']) => {
  presentSheet({
    component: <MFARecoveryCodes method={{ id: methodId }} isSetup={false} />
  });
};

const mfaSvg = (
  colors: ThemeStore['colors']
) => `<svg xmlns="http://www.w3.org/2000/svg" data-name="Layer 1" viewBox="0 0 382.94 405.93">
<path fill="${colors.pri}" d="M192.58 405.92a75.19 75.19 0 0 1-18.64-2.41l-1.2-.33-1.12-.56c-40.24-20.18-74.19-46.83-100.9-79.21a299.86 299.86 0 0 1-50.95-90.47A348.21 348.21 0 0 1 .07 110.27l.04-2.02c0-20.29 11.26-38.09 28.7-45.35C42.13 57.34 163.24 7.6 172 4c16.48-8.26 34.06-1.36 36.87-.16 6.31 2.58 118.28 48.38 142.47 59.9 24.94 11.87 31.6 33.2 31.6 43.93 0 48.6-8.43 94-25.02 134.97a312.52 312.52 0 0 1-56.16 90.51c-45.85 51.6-91.7 69.89-92.15 70.05a50.11 50.11 0 0 1-17.04 2.72zm-10.79-26.71c3.98.89 13.13 2.22 19.1.05 7.58-2.77 45.96-22.67 81.83-63.03 49.55-55.77 74.7-125.88 74.74-208.38-.1-1.67-1.28-13.59-17.07-21.1-23.72-11.3-140.1-58.89-141.27-59.37l-.32-.14c-2.44-1.02-10.2-3.17-15.55-.37l-1.08.5c-1.3.54-129.86 53.34-143.57 59.05-9.6 4-13 13.9-13 21.83 0 .58-.02 1.43-.05 2.52-1.1 56.44 11.97 195.34 156.24 268.44z"/>
<path fill="${colors.nav}" d="M177.33 15.59S47.61 68.87 33.71 74.66c-13.9 5.79-20.85 19.7-20.85 33.6 0 13.9-10.45 195.26 164.47 282.96 0 0 15.88 4.39 27.92 0 12.04-4.39 164.96-78.52 164.96-283.55 0 0 0-20.85-24.33-32.43C321.55 63.66 203.94 15.6 203.94 15.6s-14.44-6.37-26.6 0z"/>
<path d="M191.23 57.29v284.25S60.34 278.53 61.51 112.89z" opacity=".2"/>
<path fill="${colors.icon}" d="m192.94 261.58-41.69-53.61 24.24-18.86 19.75 25.38 66.7-70.4 22.3 21.13z"/>
</svg>`;

const MFASuccess = ({ recovery }: MFAStepProps) => {
  const colors = useThemeStore(state => state.colors);
  return (
    <View
      style={{
        alignItems: 'center'
      }}
    >
      <Seperator />
      <SvgView width={150} height={150} src={mfaSvg(colors)} />
      <Seperator />
      <DialogHeader
        centered={true}
        title={recovery ? 'Fallback method for 2FA enabled' : 'Two-factor authentication enabled!'}
        paragraph="Your account is now 100% secure against unauthorized logins."
        padding={12}
      />
      <Seperator />

      <Button
        title="Done"
        type="accent"
        width={250}
        onPress={() => {
          eSendEvent(eCloseProgressDialog);
        }}
        style={{
          borderRadius: 100,
          marginBottom: 10
        }}
      />

      {!recovery ? (
        <Button
          title="Setup secondary 2FA method"
          type="gray"
          height={25}
          onPress={() => {
            MFASheet.present(true);
          }}
        />
      ) : null}
    </View>
  );
};

export const MFASheet = ({ recovery }: { recovery?: boolean }) => {
  const [step, setStep] = useState<MFAStep>({
    id: 'mfapick',
    props: {
      recovery: recovery
    }
  });

  const steps: { [name: string]: JSX.Element } = {
    mfapick: (
      <MFAMethodsPickerStep
        recovery={recovery}
        onSuccess={method => {
          setStep({
            id: 'setup',
            props: {
              method: method
            }
          });
        }}
      />
    ),
    setup: (
      <MFASetup
        recovery={recovery}
        setStep={setStep}
        {...step.props}
        onSuccess={method => {
          setStep({
            id: 'recoveryCodes',
            props: {
              method: method
            }
          });
        }}
      />
    ),
    recoveryCodes: (
      <MFARecoveryCodes
        recovery={recovery}
        {...step.props}
        onSuccess={method => {
          setStep({
            id: 'success',
            props: {
              method: method
            }
          });
        }}
      />
    ),
    success: <MFASuccess {...step.props} recovery={recovery} />
  };

  return <View>{steps[step.id]}</View>;
};

MFASheet.present = (recovery?: boolean) => {
  presentSheet({
    component: <MFASheet recovery={recovery} />
  });
};
