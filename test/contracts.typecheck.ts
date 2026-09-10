import type { IAdaptiveCard } from '@microsoft/teams.cards';
import { TypingActivity } from '@microsoft/teams.api';
import { convertActivity } from '../src/teams/convert.js';
import type { ConvertActivity, ConversionResult } from '../src/teams/convert.js';
import { formatDelivery } from '../src/teams/format.js';
import type { FormatDelivery, OutgoingTeamsMessage } from '../src/teams/format.js';
import type { DeliveryRequest } from '../src/protocol/types.js';
import { personalMessage, conversionContext, expectedEvent } from './fixtures/incoming.js';
import { errorDelivery, finalMessage } from './fixtures/outgoing.js';

const convertArguments: Parameters<ConvertActivity> = [personalMessage, conversionContext];
const converter: ConvertActivity = convertActivity;
const converted: ConversionResult = convertActivity(...convertArguments);
const notification: ConversionResult = convertActivity(new TypingActivity(), conversionContext);
const accepted: ReturnType<ConvertActivity> = { kind: 'accepted', event: expectedEvent };
const ignored: ConversionResult = { kind: 'ignored', reason: 'unsupported-activity' };
const invalid: ConversionResult = { kind: 'invalid', reason: 'tenant-mismatch' };
const formatArguments: Parameters<FormatDelivery> = [errorDelivery];
const outgoing: ReturnType<FormatDelivery> = finalMessage;
const formatter: FormatDelivery = formatDelivery;

// @ts-expect-error Accepted results require an event.
const missingEvent: ConversionResult = { kind: 'accepted' };
// @ts-expect-error Delivery kinds cannot advertise progress in this contract.
const progress: DeliveryRequest = { ...errorDelivery, kind: 'progress' };
// @ts-expect-error An invalid card type must fail without going through attachment any.
const invalidCard: IAdaptiveCard = { type: 'NotAnAdaptiveCard' };
// @ts-expect-error A card reply must not also contain an ordinary text reply.
const duplicateReply: OutgoingTeamsMessage = { ...finalMessage, text: 'A second reply' };
// @ts-expect-error Exactly one card attachment is required.
const missingAttachment: OutgoingTeamsMessage = { ...finalMessage, attachments: [] };
// @ts-expect-error Two card attachments are not one outgoing card.
const extraAttachment: OutgoingTeamsMessage = { ...finalMessage, attachments: [finalMessage.attachments[0], finalMessage.attachments[0]] };

void [convertArguments, converter, converted, notification, accepted, ignored, invalid, formatArguments, outgoing, formatter,
  missingEvent, progress, invalidCard, duplicateReply, missingAttachment, extraAttachment];
