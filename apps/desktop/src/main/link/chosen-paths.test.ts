import { describe, expect, it } from 'vitest';
import { createDefaultIntegrationProfile } from '../../renderer/src/link/view-models/local-integration-profile';
import { ChosenPaths, requireChosenPrograms } from './chosen-paths';

describe('ChosenPaths', () => {
  it('只接受本次运行中操作员选择过的路径', () => {
    const chosen = new ChosenPaths('文件未经本软件的文件选择或拖放确认');
    expect(() => chosen.require('/music/song.wav')).toThrow('文件未经本软件的文件选择或拖放确认，已拒绝：/music/song.wav');
    chosen.choose('/music/song.wav');
    chosen.require('/music/song.wav');
    expect(chosen.has('/music/other.wav')).toBe(false);
  });
});

describe('requireChosenPrograms', () => {
  it('集成档案只能写入操作员选择、一键识别找到、原档案已有或默认安装位置的程序', () => {
    const chosen = new ChosenPaths('程序位置未经本软件的选择对话框或一键识别确认');
    const profile = createDefaultIntegrationProfile();
    requireChosenPrograms(profile, null, chosen);
    const planted = { ...profile, obs: { ...profile.obs, executablePath: 'C:\\Users\\Public\\伪造.exe' } };
    expect(() => requireChosenPrograms(planted, null, chosen)).toThrow('程序位置未经本软件的选择对话框或一键识别确认，已拒绝：C:\\Users\\Public\\伪造.exe');
    expect(() => requireChosenPrograms({ ...profile, ma2: { ...profile.p1, connectOnDemand: true, executablePath: 'D:\\tools\\onpc.exe' } }, null, chosen)).toThrow('一键识别确认');
    requireChosenPrograms(planted, planted, chosen);
    chosen.choose('C:\\Users\\Public\\伪造.exe');
    requireChosenPrograms(planted, null, chosen);
  });
});
