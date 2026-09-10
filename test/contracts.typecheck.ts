import type { IAdaptiveCard } from '@microsoft/teams.cards';
import type { ConvertActivity, ConversionResult } from '../src/teams/convert.js';
import type { FormatDelivery } from '../src/teams/format.js';
import type { DeliveryRequest } from '../src/protocol/types.js';
import { personalMessage, conversionContext, expectedEvent } from './fixtures/incoming.js';
import { errorDelivery, finalMessage } from './fixtures/outgoing.js';

const convertArguments: Parameters<ConvertActivity> = [personalMessage, conversionContext];
const accepted: ReturnType<ConvertActivity> = { kind: 'accepted', event: expectedEvent };
const ignored: ConversionResult = { kind: 'ignored', reason: 'unsupported-activity' };
const invalid: ConversionResult = { kind: 'invalid', reason: 'tenant-mismatch' };
const formatArguments: Parameters<FormatDelivery> = [errorDelivery];
const outgoing: ReturnType<FormatDelivery> = finalMessage;

// @ts-expect-error Accepted results require an event.
const missingEvent: ConversionResult = { kind: 'accepted' };
// @ts-expect-error Delivery kinds cannot advertise progress in this contract.
const progress: DeliveryRequest = { ...errorDelivery, kind: 'progress' };
// @ts-expect-error An invalid card type must fail without going through attachment any.
const invalidCard: IAdaptiveCard = { type: 'NotAnAdaptiveCard' };

void [convertArguments, accepted, ignored, invalid, formatArguments, outgoing,
  missingEvent, progress, invalidCard];
