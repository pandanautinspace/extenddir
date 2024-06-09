import React, { useEffect, useState } from 'react';
import logo from '../../assets/img/logo.svg';
import './Newtab.css';
import './Newtab.scss';
import OpenTab from './OpenTab';
import TabList from './TabList';

const Newtab = () => {
  let [tabs, updateTabs] = useState([]);
  useEffect(() => {
    chrome.tabs.query({}).then(ts => updateTabs(ts));
  }, []);

  //TODO: read from chrome.storage.local
  let tabLists = ["readlater"];

  return (
    <div style={{
      display: 'flex'
    }}>
      <div className="openTabHolder" style={{
        width: 30 + '%',
        backgroundColor: 'grey'
      }}>
        <ul className>
          {tabs.map((t) => (
            <OpenTab tab={t} />
          ))}
        </ul>
      </div>
      <div className="tabListHolder" style={{
        overflow: scroll,
        backgroundColor: 'aliceblue',
        flex: 1
      }}>
        {tabLists.map((tl) => (
          <TabList id={tl} />
        ))}
      </div>
    </div>
  );
};

export default Newtab;
