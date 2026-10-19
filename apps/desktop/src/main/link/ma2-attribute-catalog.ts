import { randomBytes } from 'node:crypto';
import { ma2AttributeGroupSchema, type Ma2AttributeGroup } from '@tb/schema';
import type { Ma2Telnet } from './ma2-telnet';
import { readNativeCueChunks } from './ma2-native-library';

export function parseMa2AttributeCatalog(text: string): Ma2AttributeGroup[] {
  const [header, ...rows] = text.split(';');
  if (header !== 'ok' || rows.length > 4096) throw new Error('控台属性分类目录无效');
  const result = rows.map(row => {
    const columns = row.split(',');
    if (columns.length !== 6 || columns.some(value => !/^(?:[a-f0-9]{2})+$/.test(value))) throw new Error('控台属性分类字段不完整');
    const [attribute, attributeName, presetType, presetName, feature, featureName] = columns.map(value => Buffer.from(value, 'hex').toString('utf8'));
    return ma2AttributeGroupSchema.parse({ attribute, attributeName, presetType, presetName, feature, featureName });
  });
  if (new Set(result.map(value => value.attribute)).size !== result.length) throw new Error('控台属性库名称重复，无法确认分类');
  return result;
}

/** Read the Show's actual PresetType → Feature → Attribute tree, including custom groups. */
export async function readMa2AttributeCatalog(connection: Pick<Ma2Telnet, 'command'>, beforeSend: () => void): Promise<Ma2AttributeGroup[]> {
  const prefix = `TBLINK_ATTR_${randomBytes(8).toString('hex')}:`;
  const script = `local o=gma.show.getobj;local p=gma.show.property;local function hx(s)return (s:gsub('.',function(c)return string.format('%02x',c:byte())end))end;local function n(h)local l=o.label(h);for i=0,p.amount(h)-1 do if p.name(h,i)=='Screen Name' then return hx(l),hx(p.get(h,i) or l) end end;return hx(l),hx(l)end;local r={'ok'};local h=assert(o.handle('PresetType 1'));local root=o.parent(h);for i=0,o.amount(root)-1 do local t=o.child(root,i);for j=0,o.amount(t)-1 do local f=o.child(t,j);for k=0,o.amount(f)-1 do local a=o.child(f,k);local al,an=n(a);local tl,tn=n(t);local fl,fn=n(f);r[#r+1]=table.concat({al,an,tl,tn,fl,fn},',') end end end;local s=table.concat(r,';');for i=1,#s,700 do gma.echo('${prefix}'..i..':'..s:sub(i,i+699))end;gma.echo('${prefix}END:'..#s)`;
  if (Buffer.byteLength(script) > 900) throw new Error('属性目录读取指令过长');
  beforeSend();
  const response = await connection.command(`Lua "${script}"`, text => readNativeCueChunks(text, prefix), beforeSend);
  return parseMa2AttributeCatalog(response);
}
